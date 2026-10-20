import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TaskDag } from '../components/dag/TaskDag';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { Task } from '../types/api';

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </LocaleProvider>
    </ThemeProvider>
  );
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id || 'p~t1',
    projectId: overrides.projectId || 'p',
    slug: overrides.slug || 't1',
    title: overrides.title || 'Task 1',
    level: 'easy',
    status: overrides.status || 'draft',
    dependsOn: overrides.dependsOn || [],
    attempt: 0,
    resume: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TaskDag Component', () => {
  it('renders empty message when tasks array is empty', () => {
    renderWithProviders(<TaskDag tasks={[]} />);
    expect(screen.getByTestId('task-dag-empty')).toBeInTheDocument();
    expect(screen.getByText('Không có task nào trong sơ đồ')).toBeInTheDocument();
  });

  it('renders nodes with slug, shortened title, and status badges', () => {
    const tasks: Task[] = [
      makeTask({ id: 'p~task-1', slug: 'task-1', title: 'Triển khai Authentication', status: 'running' }),
      makeTask({ id: 'p~task-2', slug: 'task-2', title: 'Thiết kế Database Schema', status: 'done', dependsOn: [] }),
    ];

    renderWithProviders(<TaskDag tasks={tasks} />);

    expect(screen.getByTestId('dag-node-p~task-1')).toBeInTheDocument();
    expect(screen.getByTestId('dag-node-p~task-2')).toBeInTheDocument();
    expect(screen.getByText('task-1')).toBeInTheDocument();
    expect(screen.getByText('task-2')).toBeInTheDocument();
    expect(screen.getByText('Triển khai Authentication')).toBeInTheDocument();
    expect(screen.getByText('Thiết kế Database Schema')).toBeInTheDocument();
  });

  it('renders model and profile info for running tasks', () => {
    const tasks: Task[] = [
      makeTask({
        id: 'p~task-run',
        slug: 'task-run',
        title: 'Running Task with Model',
        status: 'running',
        currentRun: {
          startedAt: new Date().toISOString(),
          lastOutputAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          activitySource: 'log',
        },
        modelChain: ['gemini-3.8-flash-high'],
      }),
    ];

    renderWithProviders(<TaskDag tasks={tasks} />);
    expect(screen.getByText('gemini-3.8-flash-high')).toBeInTheDocument();
  });

  it('tô đậm đường găng và đánh dấu task đang chặn nhiều task nhất ("đang chặn 4 task")', () => {
    const tasks: Task[] = [
      makeTask({ id: 'A', slug: 'task-a', title: 'Root Task A', status: 'running' }),
      makeTask({ id: 'B', slug: 'task-b', title: 'Task B', status: 'queued', dependsOn: ['A'] }),
      makeTask({ id: 'C', slug: 'task-c', title: 'Task C', status: 'queued', dependsOn: ['A'] }),
      makeTask({ id: 'D', slug: 'task-d', title: 'Task D', status: 'queued', dependsOn: ['B'] }),
      makeTask({ id: 'E', slug: 'task-e', title: 'Task E', status: 'queued', dependsOn: ['C'] }),
    ];

    renderWithProviders(<TaskDag tasks={tasks} />);

    // Check legend / stats
    expect(screen.getByText('Đang chặn 4 task')).toBeInTheDocument();

    // Node A is top blocker with 4 blocked tasks
    const nodeA = screen.getByTestId('dag-node-A');
    expect(nodeA).toHaveAttribute('data-max-blocker', 'true');
    expect(nodeA).toHaveAttribute('data-critical', 'true');

    // Edges
    const edgeAB = screen.getByTestId('dag-edge-A-B');
    expect(edgeAB).toBeInTheDocument();
    expect(edgeAB).toHaveAttribute('data-critical', 'true');
  });

  it('clicking a node triggers onSelectTask callback', () => {
    const onSelect = vi.fn();
    const task = makeTask({ id: 'click-me', slug: 'click-me', title: 'Clickable Task' });

    renderWithProviders(<TaskDag tasks={[task]} onSelectTask={onSelect} />);

    const node = screen.getByTestId('dag-node-click-me');
    fireEvent.click(node);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(task);
  });

  it('zoom controls change zoom scale', () => {
    const tasks: Task[] = [makeTask({ id: 'zoom-task', slug: 'zoom-task' })];
    renderWithProviders(<TaskDag tasks={tasks} />);

    expect(screen.getByText('100%')).toBeInTheDocument();

    const zoomInBtn = screen.getByLabelText('Phóng to');
    fireEvent.click(zoomInBtn);
    expect(screen.getByText('115%')).toBeInTheDocument();

    const zoomOutBtn = screen.getByLabelText('Thu nhỏ');
    fireEvent.click(zoomOutBtn);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
