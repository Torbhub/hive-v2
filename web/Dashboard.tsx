import React, { useContext, useState } from 'react';
import {
  Alert, AppBar, Box, Button, Chip, Divider, Drawer, List, ListItemButton, ListItemText,
  ListSubheader, Stack, Toolbar, Typography,
} from '@mui/material';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Approvals, HubView, ProjectMode, QuestionAnswer, QuestionBatch } from '../src/types';
import { ago, buildNeeds, homeTilde } from '../src/ui/look';
import { StretchText } from './Stretch';
import { ActionContext } from './action';
import { ProjectCard } from './project';
import { NeedCard } from './needs';
import { BatchCard } from './questions';
import { AddProjectRow } from './rows';
import { WorkTreeView } from './WorkTree';

type Busy = { project: string; what: string; who?: string } | null;

export function Dashboard({
  view, busy, refresh, onQuestionsOpen, onWake, onStartTask, onSetMode, onSetApprovals,
  onMessage, onNudge, onAnswer, onContinue, onPlanAnswer, onResolve, onInterrupt, onLogs,
  onBranches, onKill, onDelete, onAddProject, onQuestionAnswer, onQuestionCancel,
}: {
  view: HubView;
  busy: Busy;
  refresh: () => Promise<void>;
  onQuestionsOpen: () => void;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
  onSetApprovals: (project: string, approvals: Approvals) => void;
  onMessage: (project: string, text: string) => Promise<boolean>;
  onNudge: (project: string, taskId: string) => void;
  onAnswer: (project: string, agent: string | undefined, seen: string, choice: string, id: string) => void;
  onContinue: (project: string) => void;
  onPlanAnswer: (project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => void;
  onResolve: (project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => void;
  onInterrupt: (project: string, ref?: string) => void;
  onLogs: (project: string, ref?: string) => void;
  onBranches: (project: string) => void;
  onKill: (project: string) => void;
  onDelete: (project: string) => void;
  onAddProject: (name: string, folder: string, source: string) => Promise<boolean>;
  onQuestionAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onQuestionCancel: (batch: QuestionBatch) => void;
}) {
  const { acting } = useContext(ActionContext);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = view.projects.find((project) => project.name === selectedName) ?? view.projects[0];
  const now = Date.now();
  const needs = buildNeeds(view, now);
  const sources = [...new Set(view.projects.flatMap((project) =>
    project.repos.filter((repo) => repo.kind === 'repo' || repo.kind === 'worktree').map((repo) => repo.folder),
  ))];
  const clock = view.updatedAt ? new Date(view.updatedAt).toTimeString().slice(0, 5) : 'reading…';

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Drawer
        variant="permanent"
        sx={{ width: 260, flexShrink: 0, '& .MuiDrawer-paper': { width: 260, position: 'relative' } }}
      >
        <Toolbar>
          <Stack>
            <Typography variant="h6">hive</Typography>
            <Typography variant="caption" color="text.secondary" noWrap>{homeTilde(view.root, '')}</Typography>
          </Stack>
        </Toolbar>
        <Divider />
        <Box sx={{ overflow: 'auto' }}>
          <List
            data-testid="project-nav"
            subheader={<ListSubheader component="div">Projects</ListSubheader>}
          >
            {view.projects.map((project) => (
              <ListItemButton
                key={project.name}
                selected={selected?.name === project.name}
                disabled={acting}
                onClick={() => setSelectedName(project.name)}
              >
                <ListItemText primary={project.name} secondary={`${project.agents.length} agents · ${project.open_tasks} open`} />
              </ListItemButton>
            ))}
          </List>
          <Divider />
          <AddProjectRow sources={sources} onAddProject={onAddProject} />
        </Box>
      </Drawer>
      <Box sx={{ display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column' }}>
        <AppBar position="static" color="transparent" elevation={0}>
          <Toolbar>
            <Typography variant="h6" sx={{ flex: 1 }}>{selected?.name ?? 'Projects'}</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              {view.updatedAt !== 0 && <Chip size="small" label="relay" color="success" variant="outlined" />}
              <Typography variant="caption" color="text.secondary">{clock}</Typography>
              <Button href="/" size="small" disabled={acting}>Nexus</Button>
              <Button size="small" onClick={() => void refresh()}>refresh</Button>
              {view.questions.length > 0 && (
                <Button id="questions-open" size="small" variant="contained" disabled={acting} onClick={onQuestionsOpen}>
                  Questions {view.questionsTotal ?? view.questions.length}
                </Button>
              )}
            </Stack>
          </Toolbar>
          <Divider />
        </AppBar>
        <Box sx={{ minHeight: 0, flex: 1 }}>
          <Group orientation="horizontal">
            <Panel defaultSize="66%" minSize="35%">
              <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
                {selected ? (
                  <ProjectCard
                    project={selected}
                    view={view}
                    now={now}
                    busy={busy}
                    onWake={onWake}
                    onStartTask={onStartTask}
                    onSetMode={onSetMode}
                    onSetApprovals={onSetApprovals}
                    onMessage={onMessage}
                    onNudge={onNudge}
                    onInterrupt={onInterrupt}
                    onLogs={onLogs}
                    onBranches={onBranches}
                    onKill={onKill}
                    onDelete={onDelete}
                  />
                ) : (
                  <Typography color="text.secondary">
                    {view.updatedAt !== 0 && view.error === '' ? 'No projects yet: tell the hub which folders make up a project.' : 'Reading projects…'}
                  </Typography>
                )}
              </Box>
            </Panel>
            <Separator>
              <Divider orientation="vertical" sx={{ height: '100%', mx: '2px' }} />
            </Separator>
            <Panel defaultSize="34%" minSize="25%">
              <Box sx={{ height: '100%', overflow: 'auto', p: 2 }}>
                <Stack spacing={2}>
                  {view.error !== '' && <Alert severity="error">{view.error}</Alert>}
                  {needs.length > 0 && (
                    <section>
                      <Typography variant="overline" color="secondary">Needs you</Typography>
                      <Stack spacing={1} sx={{ mt: 1 }}>
                        {needs.map((need) => (
                          <NeedCard
                            key={need.key}
                            need={need}
                            view={view}
                            busy={busy}
                            onAnswer={onAnswer}
                            onContinue={onContinue}
                            onPlanAnswer={onPlanAnswer}
                            onResolve={onResolve}
                            onNudge={onNudge}
                          />
                        ))}
                      </Stack>
                    </section>
                  )}
                  {view.questions.map((batch) => (
                    <BatchCard key={batch.id} batch={batch} onAnswer={onQuestionAnswer} onCancel={onQuestionCancel} />
                  ))}
                  {view.workTree && <WorkTreeView tree={view.workTree} onChanged={refresh} />}
                  {view.decisions.length > 0 && (
                    <section>
                      <Typography variant="overline" color="text.secondary">Decisions</Typography>
                      <Stack spacing={1} sx={{ mt: 1 }}>
                        {view.decisions.map((decision, index) => (
                          <Box key={`${decision.at}-${index}`}>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>{decision.task ?? decision.project}</Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{ago(decision.at, now)}</Typography>
                            </Stack>
                            <StretchText text={decision.summary} pane={decision.task ?? decision.project} className="text-zinc-400" />
                          </Box>
                        ))}
                      </Stack>
                    </section>
                  )}
                </Stack>
              </Box>
            </Panel>
          </Group>
        </Box>
      </Box>
    </Box>
  );
}
