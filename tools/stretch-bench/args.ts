// Tiny argv helper shared by the bench scripts: option('--name', 'fallback').
export function makeOption(args: string[]): (name: string, fallback: string) => string {
  return (name, fallback) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1] ?? fallback;
  };
}
