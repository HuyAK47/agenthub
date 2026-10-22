import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfig, getSetupStatus, updateConfig } from '../../api/client';

export type TourStep = {
  id: string;
  route?: string;
  selector: string;
  title: string;
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
};

export type TourDefinition = { id: string; steps: TourStep[] };

type TourContextValue = {
  active: TourDefinition | null;
  stepIndex: number;
  openTour: (id: string) => void;
  closeTour: (completed?: boolean) => void;
  next: () => void;
  previous: () => void;
  getPageTour: (pathname: string) => TourDefinition | null;
};

const fallbackKey = 'agenthub_tours_seen';

export const tourDefinitions: TourDefinition[] = [
  { id: 'intro', steps: [
    { id: 'overview', route: '/', selector: '[data-tour="overview"]', title: 'Tổng quan', content: 'Theo dõi worker đang chạy, quota và bộ não điều phối.', placement: 'bottom' },
    { id: 'setup', route: '/setup', selector: '[data-tour="setup"]', title: 'Thiết lập', content: 'Cài CLI và hoàn tất các bước thiết lập ban đầu.', placement: 'right' },
    { id: 'profiles', route: '/profiles', selector: '[data-tour="profiles"]', title: 'Tài khoản', content: 'Thêm hoặc đăng nhập tài khoản agy, Codex và Claude.', placement: 'right' },
    { id: 'projects', route: '/projects', selector: '[data-tour="projects"]', title: 'Project', content: 'Đăng ký dự án và mở cài đặt bộ não, quyền, worktree.', placement: 'right' },
    { id: 'chat', route: '/chat', selector: '[data-tour="chat"]', title: 'Chat', content: 'Nói chuyện với Trợ lý hoặc bộ não và giao việc bằng lời.', placement: 'right' },
    { id: 'tasks', route: '/tasks', selector: '[data-tour="tasks"]', title: 'Task', content: 'Theo dõi task, log và duyệt kết quả worker.', placement: 'right' },
    { id: 'plans', route: '/plans', selector: '[data-tour="plans"]', title: 'Kế hoạch', content: 'Xem Claude chia việc và theo dõi tiến độ.', placement: 'right' },
    { id: 'settings', route: '/settings', selector: '[data-tour="settings"]', title: 'Cài đặt', content: 'Cấu hình Telegram, duyệt kế hoạch và thông báo.', placement: 'right' },
    { id: 'telegram', route: '/settings', selector: '[data-tour="telegram"]', title: 'Telegram', content: 'Điều khiển hub bằng /use, /newtask, /status, /digest…', placement: 'top' },
  ] },
];

const pageTours: Record<string, TourDefinition> = {
  '/': { id: 'page-dashboard', steps: [
    { id: 'overview', selector: '[data-tour="overview"]', title: 'Tổng quan', content: 'Đây là nơi xem nhanh sức khỏe của hub.', placement: 'bottom' },
    { id: 'brain', selector: '[data-tour="brain"]', title: 'Bộ não', content: 'Claude điều phối và theo dõi các worker tại đây.', placement: 'bottom' },
    { id: 'workers', selector: '[data-tour="workers"]', title: 'Worker', content: 'Các task đang chạy và log trực tiếp xuất hiện ở khu vực này.', placement: 'top' },
  ] },
  '/projects': { id: 'page-projects', steps: [
    { id: 'projects', selector: '[data-tour="projects"]', title: 'Project', content: 'Danh sách project đã đăng ký với AgentHub.', placement: 'bottom' },
  ] },
  '/settings': { id: 'page-settings', steps: [
    { id: 'settings', selector: '[data-tour="settings"]', title: 'Cài đặt', content: 'Điều chỉnh cách hub điều phối worker.', placement: 'bottom' },
    { id: 'telegram', selector: '[data-tour="telegram"]', title: 'Telegram', content: 'Kết nối bot và chọn loại thông báo.', placement: 'top' },
  ] },
  '/setup': { id: 'page-setup', steps: [
    { id: 'setup', selector: '[data-tour="setup"]', title: 'Thiết lập', content: 'Kiểm tra công cụ, MCP và tài khoản worker.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
  '/profiles': { id: 'page-profiles', steps: [
    { id: 'profiles', selector: '[data-tour="profiles"]', title: 'Tài khoản', content: 'Theo dõi quota và đăng nhập các tài khoản worker.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
  '/tasks': { id: 'page-tasks', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'Task', content: 'Xem Kanban, sơ đồ phụ thuộc và tạo task mới.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
  '/tasks-detail': { id: 'page-task-detail', steps: [
    { id: 'tasks', selector: '[data-tour="tasks"]', title: 'Chi tiết task', content: 'Từ đây bạn có thể xem log, báo cáo và review task.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
  '/chat': { id: 'page-chat', steps: [
    { id: 'chat', selector: '[data-tour="chat"]', title: 'Chat', content: 'Trao đổi trực tiếp với Claude hoặc Trợ lý.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
  '/plans': { id: 'page-plans', steps: [
    { id: 'plans', selector: '[data-tour="plans"]', title: 'Kế hoạch', content: 'Xem, chỉnh sửa và duyệt kế hoạch của Claude.', placement: 'right' },
    { id: 'help', selector: '[data-tour="help"]', title: 'Trợ giúp', content: 'Mở lại hướng dẫn trang này bất cứ lúc nào.', placement: 'bottom' },
  ] },
};

const noOpTourContext: TourContextValue = {
  active: null,
  stepIndex: 0,
  openTour: () => {},
  closeTour: () => {},
  next: () => {},
  previous: () => {},
  getPageTour: () => null,
};

const TourContext = createContext<TourContextValue>(noOpTourContext);

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 });
  const { data: setup } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, staleTime: 10_000 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  const seen = config?.ui?.tours || {};
  const getPageTour = useCallback((pathname: string) => {
    if (pathname.startsWith('/tasks/') && pathname !== '/tasks/new') return pageTours['/tasks-detail'];
    const key = Object.keys(pageTours).find((candidate) => candidate === pathname || (candidate !== '/' && pathname.startsWith(`${candidate}/`)));
    return key ? pageTours[key] : null;
  }, []);
  const active = useMemo(() => tourDefinitions.find((tour) => tour.id === activeId) || (activeId ? Object.values(pageTours).find((tour) => tour.id === activeId) || null : null), [activeId]);

  const markSeen = useCallback(async (id: string) => {
    try {
      const old = JSON.parse(localStorage.getItem(fallbackKey) || '{}');
      localStorage.setItem(fallbackKey, JSON.stringify({ ...old, [id]: true }));
    } catch { /* storage is optional */ }
    try {
      await updateConfig({ ui: { tours: { ...seen, [id]: true } } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
    }
  }, [queryClient, seen]);

  const openTour = useCallback((id: string) => {
    const tour = tourDefinitions.find((item) => item.id === id) || Object.values(pageTours).find((item) => item.id === id);
    if (!tour) return;
    setActiveId(tour.id);
    setStepIndex(0);
    if (tour.steps[0]?.route && location.pathname !== tour.steps[0].route) navigate(tour.steps[0].route);
  }, [location.pathname, navigate]);

  const closeTour = useCallback((completed = true) => {
    if (active) void markSeen(active.id);
    setActiveId(null);
    setStepIndex(0);
    void completed;
  }, [active, markSeen]);

  const next = useCallback(() => {
    if (!active) return;
    if (stepIndex >= active.steps.length - 1) { closeTour(true); return; }
    const nextIndex = stepIndex + 1;
    setStepIndex(nextIndex);
    const nextStep = active.steps[nextIndex];
    if (nextStep.route && location.pathname !== nextStep.route) navigate(nextStep.route);
  }, [active, closeTour, location.pathname, navigate, stepIndex]);

  const previous = useCallback(() => {
    if (!active || stepIndex === 0) return;
    const previousIndex = stepIndex - 1;
    setStepIndex(previousIndex);
    const previousStep = active.steps[previousIndex];
    if (previousStep.route && location.pathname !== previousStep.route) navigate(previousStep.route);
  }, [active, location.pathname, navigate, stepIndex]);

  useEffect(() => {
    if (!setup || activeId || !(setup.setupCompletedAt || setup.setupSkippedAt)) return;
    let localSeen: Record<string, boolean> = {};
    try { localSeen = JSON.parse(localStorage.getItem(fallbackKey) || '{}'); } catch { /* ignore */ }
    if (!seen.intro && !localSeen.intro) openTour('intro');
  }, [activeId, openTour, seen.intro, setup]);

  return <TourContext.Provider value={{ active, stepIndex, openTour, closeTour, next, previous, getPageTour }}>{children}</TourContext.Provider>;
};

export function useTour(): TourContextValue {
  return useContext(TourContext);
}
