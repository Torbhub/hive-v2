import React, { useEffect, useMemo, useRef } from 'react';
import {
  Background, BackgroundVariant, Handle, Position, ReactFlow, useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { HubProject } from '../src/types';
import { agentRef } from '../src/ui/look';
import { Badge } from './components/ui/badge';
import { Card, CardContent } from './components/ui/card';
import { useMediaQuery } from './hooks/use-mobile';

type TeamData = { label: string; state: string; color: string; project: string; agent?: string };
type TeamNode = Node<TeamData, 'team'>;
type TeamEdge = Edge;

function TeamNodeCard({ data }: NodeProps<TeamNode>) {
  return (
    <Card
      className="w-[180px] cursor-pointer gap-2 py-3 shadow-none"
      style={{ borderColor: data.color }}
    >
      <CardContent className="px-3">
        <Handle type="target" position={Position.Top} />
        <div className="flex min-w-0 items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: data.color }} />
          <span className="min-w-0 break-words text-sm font-semibold leading-snug" title={data.label}>{data.label}</span>
        </div>
        <Badge variant="outline" className="mt-2" style={{ borderColor: `${data.color}66`, color: data.color }}>
          {data.state}
        </Badge>
        <Handle type="source" position={Position.Bottom} />
      </CardContent>
    </Card>
  );
}

const nodeTypes = { team: TeamNodeCard };

function FitViewOnResize({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const fitView = useReactFlow().fitView;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => void fitView());
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, fitView]);
  return null;
}

function colorFor(state: string): string {
  if (state === 'running') return '#10b981';
  if (state === 'stopped' || state === 'resumable') return '#f59e0b';
  if (state === 'none') return '#71717a';
  return '#ef4444';
}

export function TeamMap({ project, onOpenAgent }: { project: HubProject; onOpenAgent?: (project: string, agent?: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery('(max-width: 640px)');
  const flow = useMemo(() => {
    const orchestrator: TeamNode = {
      id: 'orchestrator',
      type: 'team',
      position: { x: narrow ? 60 : 220, y: 20 },
      data: {
        label: project.orchestrator.name ?? `${project.name}-orchestrator`,
        state: project.orchestrator.state,
        color: colorFor(project.orchestrator.state),
        project: project.name,
      },
    };
    const agents = project.agents.map((agent, index): TeamNode => ({
      id: `agent-${agent.ref ?? agent.name}`,
      type: 'team',
      position: narrow ? { x: 60, y: 190 + index * 150 } : { x: (index % 3) * 220, y: 190 + Math.floor(index / 3) * 150 },
      data: { label: agentRef(agent), state: agent.state, color: colorFor(agent.state), project: project.name, agent: agentRef(agent) },
    }));
    const edges = agents.map((agent): TeamEdge => ({
      id: `orchestrator-${agent.id}`,
      source: 'orchestrator',
      target: agent.id,
      animated: agent.data.state === 'running',
      style: { stroke: '#52525b', strokeWidth: 1.5 },
    }));
    return { nodes: [orchestrator, ...agents], edges };
  }, [project, narrow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges);

  useEffect(() => {
    setNodes((current) => flow.nodes.map((node) => ({
      ...node,
      position: current.find((candidate) => candidate.id === node.id)?.position ?? node.position,
    })));
  }, [flow.nodes, setNodes]);
  useEffect(() => setEdges(flow.edges), [flow.edges, setEdges]);

  return (
    <div ref={containerRef} data-testid="team-map" className="h-[360px] min-w-0 overflow-hidden rounded-lg border bg-muted/20">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onOpenAgent?.(node.data.project, node.data.agent)}
        nodesConnectable={false}
        nodesDraggable
        fitView
        minZoom={0.4}
        maxZoom={1.5}
        className="dark"
        aria-label={`Team map for ${project.name}`}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#52525b" />
        <FitViewOnResize container={containerRef} />
      </ReactFlow>
    </div>
  );
}
