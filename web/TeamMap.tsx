import React, { useEffect, useMemo } from 'react';
import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import {
  Background, BackgroundVariant, Handle, Position, ReactFlow, useEdgesState, useNodesState,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { HubProject } from '../src/types';
import { agentRef } from '../src/ui/look';

type TeamData = { label: string; state: string; color: string };
type TeamNode = Node<TeamData, 'team'>;
type TeamEdge = Edge;

function TeamNodeCard({ data }: NodeProps<TeamNode>) {
  return (
    <Card sx={{ width: 180, border: 1, borderColor: data.color, boxShadow: `0 0 24px ${data.color}33` }}>
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Handle type="target" position={Position.Top} />
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: data.color }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{data.label}</Typography>
        </Stack>
        <Chip size="small" label={data.state} variant="outlined" sx={{ mt: 1 }} />
        <Handle type="source" position={Position.Bottom} />
      </CardContent>
    </Card>
  );
}

const nodeTypes = { team: TeamNodeCard };

function colorFor(state: string): string {
  if (state === 'running') return '#10b981';
  if (state === 'stopped' || state === 'resumable') return '#f59e0b';
  if (state === 'none') return '#71717a';
  return '#ef4444';
}

export function TeamMap({ project }: { project: HubProject }) {
  const flow = useMemo(() => {
    const orchestrator: TeamNode = {
      id: 'orchestrator',
      type: 'team',
      position: { x: 220, y: 20 },
      data: {
        label: project.orchestrator.name ?? `${project.name}-orchestrator`,
        state: project.orchestrator.state,
        color: colorFor(project.orchestrator.state),
      },
    };
    const agents = project.agents.map((agent, index): TeamNode => ({
      id: `agent-${agent.ref ?? agent.name}`,
      type: 'team',
      position: { x: (index % 3) * 220, y: 190 + Math.floor(index / 3) * 150 },
      data: { label: agentRef(agent), state: agent.state, color: colorFor(agent.state) },
    }));
    const edges = agents.map((agent): TeamEdge => ({
      id: `orchestrator-${agent.id}`,
      source: 'orchestrator',
      target: agent.id,
      animated: agent.data.state === 'running',
      style: { stroke: '#a78bfa', strokeWidth: 2, strokeDasharray: '7 5' },
    }));
    return { nodes: [orchestrator, ...agents], edges };
  }, [project]);
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
    <Box data-testid="team-map" sx={{ height: 360, mt: 2, border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesConnectable={false}
        nodesDraggable
        fitView
        minZoom={0.4}
        maxZoom={1.5}
        className="dark"
        aria-label={`Team map for ${project.name}`}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#52525b" />
      </ReactFlow>
    </Box>
  );
}
