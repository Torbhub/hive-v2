import errno
import importlib.util
import socket
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('llm_forward', ROOT / 'infra/box/llm-forward.py')
forwarder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(forwarder)


class FakeSocket:
    def __init__(self):
        self.closed = False

    def settimeout(self, timeout):
        pass

    def shutdown(self, how):
        pass

    def close(self):
        self.closed = True


class RelayChecks(unittest.TestCase):
    def start_relay(self, idle=0.05):
        client, client_peer = socket.socketpair()
        upstream, upstream_peer = socket.socketpair()
        client_peer.settimeout(1)
        upstream_peer.settimeout(1)
        thread = threading.Thread(target=forwarder.handle, args=(client,), daemon=True)
        patches = mock.patch.object(forwarder, 'IDLE_TIMEOUT', idle, create=True), mock.patch.object(
            forwarder.socket, 'create_connection', return_value=upstream,
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        thread.start()
        self.addCleanup(self.close_all, thread, client, client_peer, upstream, upstream_peer)
        return thread, client_peer, upstream_peer

    def close_all(self, thread, *sockets):
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass
        thread.join(1)
        self.assertFalse(thread.is_alive(), 'connection thread did not finish during cleanup')

    def assert_finished(self, thread):
        thread.join(1)
        self.assertFalse(thread.is_alive(), 'connection thread remained blocked')

    def test_slow_active_stream_finishes(self):
        thread, client, upstream = self.start_relay(idle=0.2)
        upstream.sendall(b'first')
        self.assertEqual(client.recv(5), b'first')
        time.sleep(0.12)
        upstream.sendall(b'second')
        self.assertEqual(client.recv(6), b'second')
        time.sleep(0.12)
        upstream.sendall(b'third')
        upstream.shutdown(socket.SHUT_WR)
        received = b'firstsecond'
        while True:
            chunk = client.recv(1024)
            if not chunk:
                break
            received += chunk
        client.shutdown(socket.SHUT_WR)
        self.assert_finished(thread)
        self.assertEqual(received, b'firstsecondthird')

    def test_upstream_stall_closes_connection(self):
        thread, client, upstream = self.start_relay()
        client.sendall(b'request')
        self.assert_finished(thread)
        self.assertEqual(client.recv(1), b'')

    def test_client_stall_closes_connection(self):
        thread, client, upstream = self.start_relay()
        upstream.sendall(b'response')
        self.assertEqual(client.recv(8), b'response')
        self.assert_finished(thread)
        self.assertEqual(client.recv(1), b'')

    def test_half_close_closes_both_directions(self):
        thread, client, upstream = self.start_relay()
        upstream.sendall(b'partial')
        upstream.shutdown(socket.SHUT_WR)
        self.assertEqual(client.recv(7), b'partial')
        self.assert_finished(thread)
        self.assertEqual(client.recv(1), b'')

    def test_failure_closes_both_sockets(self):
        client = FakeSocket()
        upstream = FakeSocket()
        selector = mock.Mock()
        selector.select.side_effect = OSError('select failed')
        with mock.patch.object(forwarder.socket, 'create_connection', return_value=upstream), mock.patch.object(
            forwarder, 'select', selector, create=True,
        ):
            forwarder.handle(client)
        self.assertTrue(client.closed)
        self.assertTrue(upstream.closed)

    def test_connect_timeout_remains_distinct(self):
        client = FakeSocket()
        with mock.patch.object(forwarder.socket, 'create_connection', side_effect=OSError('offline')) as connect:
            forwarder.handle(client)
        connect.assert_called_once_with(forwarder.TARGET, timeout=10)
        self.assertTrue(client.closed)


class RetryLimit(Exception):
    pass


class AcceptDone(Exception):
    pass


class ControlledClock:
    def __init__(self, limit=20):
        self.now = 0
        self.limit = limit
        self.sleeps = []
        self.inspection_timeouts = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.now > self.limit:
            raise RetryLimit


class FakeServer:
    def __init__(self, bind_errors, clients=(), before_accept=None):
        self.bind_errors = list(bind_errors)
        self.clients = list(clients)
        self.before_accept = before_accept
        self.bind_calls = 0
        self.closed = False

    def setsockopt(self, level, option, value):
        pass

    def bind(self, address):
        self.bind_calls += 1
        if self.bind_errors:
            error = self.bind_errors.pop(0)
            if error is not None:
                raise error

    def listen(self, backlog):
        pass

    def accept(self):
        if not self.clients:
            raise AcceptDone
        if self.before_accept is not None:
            self.before_accept()
        return self.clients.pop(0), ('test', 0)

    def close(self):
        self.closed = True


class FakeThread:
    instances = []

    def __init__(self, target, args, daemon):
        self.target = target
        self.args = args
        self.daemon = daemon
        self.started = False
        self.error = None
        self.instances.append(self)

    def start(self):
        self.started = True

    def run(self):
        try:
            self.target(*self.args)
        except Exception as error:
            self.error = error


class FailingThread(FakeThread):
    def start(self):
        raise RuntimeError('thread start failed')


def completed(returncode=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class StartupChecks(unittest.TestCase):
    def clock_patches(self, clock, startup_timeout=6):
        return (
            mock.patch.object(forwarder.time, 'monotonic', clock.monotonic),
            mock.patch.object(forwarder.time, 'sleep', clock.sleep),
            mock.patch.object(forwarder, 'STARTUP_TIMEOUT', startup_timeout, create=True),
            mock.patch.object(forwarder, 'RETRY_DELAY', 2, create=True),
            mock.patch.object(forwarder, 'MAX_RETRY_DELAY', 4, create=True),
        )

    def run_gateway(self, results, clock, elapsed=None, startup_timeout=6):
        outcomes = iter(results)
        durations = iter(elapsed or [0] * len(results))

        def inspect(*args, **kwargs):
            clock.inspection_timeouts.append(kwargs['timeout'])
            clock.now += next(durations)
            outcome = next(outcomes)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        patches = self.clock_patches(clock, startup_timeout) + (
            mock.patch.object(forwarder.subprocess, 'run', side_effect=inspect),
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            return forwarder.gateway_ip()

    def run_main(self, server, clock):
        patches = self.clock_patches(clock) + (
            mock.patch.object(forwarder, 'gateway_ip', return_value='172.18.0.1'),
            mock.patch.object(forwarder.socket, 'socket', return_value=server),
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            return forwarder.main()

    def test_transient_discovery_recovers_with_bounded_backoff(self):
        clock = ControlledClock()
        address = self.run_gateway([
            completed(stdout=''),
            completed(returncode=1, stderr='Error response from daemon: network tdai-memory-stack not found'),
            completed(stdout='172.18.0.1\n'),
        ], clock, startup_timeout=7)
        self.assertEqual(address, '172.18.0.1')
        self.assertEqual(clock.sleeps, [2, 4])

    def test_discovery_deadline_is_bounded(self):
        clock = ControlledClock()
        with self.assertRaisesRegex(TimeoutError, 'gateway'):
            self.run_gateway([
                completed(returncode=1, stderr='network tdai-memory-stack not found'),
            ] * 10, clock)
        self.assertEqual(sum(clock.sleeps), 6)

    def test_discovery_caps_inspection_to_remaining_budget(self):
        clock = ControlledClock()
        with self.assertRaisesRegex(TimeoutError, 'gateway'):
            self.run_gateway([
                completed(returncode=1, stderr='network tdai-memory-stack not found'),
                forwarder.subprocess.TimeoutExpired('docker', 3),
            ], clock, elapsed=[1, 3])
        self.assertEqual(clock.inspection_timeouts, [6, 3])
        self.assertEqual(clock.sleeps, [2])
        self.assertEqual(clock.now, 6)

    def test_missing_docker_surfaces(self):
        clock = ControlledClock(limit=0)
        missing = FileNotFoundError(errno.ENOENT, 'No such file or directory', 'docker')
        with self.assertRaises(FileNotFoundError) as caught:
            self.run_gateway([missing], clock)
        self.assertIs(caught.exception, missing)
        self.assertEqual(clock.sleeps, [])

    def test_unexpected_subprocess_error_surfaces(self):
        clock = ControlledClock(limit=0)
        failure = RuntimeError('unexpected docker failure')
        with self.assertRaises(RuntimeError) as caught:
            self.run_gateway([failure], clock)
        self.assertIs(caught.exception, failure)
        self.assertEqual(clock.sleeps, [])

    def test_discovery_command_failure_surfaces_stderr(self):
        clock = ControlledClock(limit=0)
        with self.assertRaisesRegex(RuntimeError, 'permission denied'):
            self.run_gateway([completed(returncode=1, stderr='permission denied')], clock)
        self.assertEqual(clock.sleeps, [])

    def test_address_not_available_recovers(self):
        clock = ControlledClock()
        server = FakeServer([OSError(errno.EADDRNOTAVAIL, 'not ready'), None])
        with self.assertRaises(AcceptDone):
            self.run_main(server, clock)
        self.assertEqual(server.bind_calls, 2)
        self.assertEqual(clock.sleeps, [2])

    def test_bind_deadline_is_bounded_and_preserves_cause(self):
        clock = ControlledClock()
        server = FakeServer([OSError(errno.EADDRNOTAVAIL, 'not ready')] * 10)
        with self.assertRaises(TimeoutError) as caught:
            self.run_main(server, clock)
        self.assertEqual(caught.exception.__cause__.errno, errno.EADDRNOTAVAIL)
        self.assertEqual(sum(clock.sleeps), 6)
        self.assertTrue(server.closed)

    def test_permanent_bind_errors_surface(self):
        errors = [
            OSError(errno.EADDRINUSE, 'address in use'),
            OSError(errno.EACCES, 'permission denied'),
            OSError(errno.EINVAL, 'invalid address'),
            socket.gaierror(socket.EAI_NONAME, 'Name or service not known'),
        ]
        for error in errors:
            with self.subTest(error=error):
                clock = ControlledClock(limit=0)
                server = FakeServer([error])
                with self.assertRaises(OSError) as caught:
                    self.run_main(server, clock)
                self.assertIs(caught.exception, error)
                self.assertEqual(clock.sleeps, [])
                self.assertTrue(server.closed)


class ConcurrencyChecks(unittest.TestCase):
    def run_main(self, server):
        with mock.patch.object(forwarder, 'gateway_ip', return_value='172.18.0.1'), mock.patch.object(
            forwarder.socket, 'socket', return_value=server,
        ):
            return forwarder.main()

    def test_saturation_closes_excess_and_failure_releases_capacity(self):
        clients = [FakeSocket() for _ in range(4)]
        server = None

        def recover():
            if len(server.clients) == 1:
                for thread in FakeThread.instances:
                    thread.run()

        server = FakeServer([], clients, recover)
        FakeThread.instances = []
        with mock.patch.object(forwarder, 'MAX_CONNECTIONS', 2, create=True), mock.patch.object(
            forwarder.threading, 'Thread', FakeThread,
        ), mock.patch.object(forwarder.socket, 'create_connection', side_effect=OSError('offline')):
            with self.assertRaises(AcceptDone):
                self.run_main(server)
        self.assertEqual(len(FakeThread.instances), 3)
        self.assertTrue(all(thread.started for thread in FakeThread.instances))
        self.assertTrue(clients[0].closed)
        self.assertTrue(clients[1].closed)
        self.assertTrue(clients[2].closed)
        self.assertFalse(clients[3].closed)

    def test_thread_start_failure_closes_client_and_releases_slot(self):
        client = FakeSocket()
        server = FakeServer([], [client])
        semaphore_type = threading.BoundedSemaphore
        semaphores = []

        def make_semaphore(value):
            semaphore = semaphore_type(value)
            semaphores.append(semaphore)
            return semaphore

        with mock.patch.object(forwarder, 'MAX_CONNECTIONS', 1, create=True), mock.patch.object(
            forwarder.threading, 'BoundedSemaphore', make_semaphore, create=True,
        ), mock.patch.object(forwarder.threading, 'Thread', FailingThread):
            with self.assertRaisesRegex(RuntimeError, 'thread start failed'):
                self.run_main(server)
        self.assertTrue(client.closed)
        self.assertEqual(len(semaphores), 1)
        self.assertTrue(semaphores[0].acquire(blocking=False))
        semaphores[0].release()

    def test_timeout_releases_connection_slot(self):
        semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(semaphore.acquire(blocking=False))
        client, client_peer = socket.socketpair()
        upstream, upstream_peer = socket.socketpair()
        thread = None
        try:
            with mock.patch.object(forwarder, 'IDLE_TIMEOUT', 0.05), mock.patch.object(
                forwarder.socket, 'create_connection', return_value=upstream,
            ):
                thread = threading.Thread(target=forwarder.run_connection, args=(client, semaphore), daemon=True)
                thread.start()
                thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertTrue(semaphore.acquire(blocking=False))
            semaphore.release()
        finally:
            for sock in (client, client_peer, upstream, upstream_peer):
                sock.close()
            if thread is not None:
                thread.join(1)
            self.assertFalse(thread is not None and thread.is_alive())


if __name__ == '__main__':
    unittest.main()
