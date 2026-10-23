import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { createDepartment, deleteDepartment, getDepartments, updateDepartment } from '../api/client';
import { useLocale } from '../context/LocaleContext';

export const DepartmentsPage: React.FC = () => {
  const { t } = useLocale();
  const client = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ['departments'], queryFn: getDepartments });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['departments'] });
  const create = useMutation({ mutationFn: createDepartment, onSuccess: () => { setName(''); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: object }) => updateDepartment(id, data), onSuccess: refresh });
  const remove = useMutation({ mutationFn: deleteDepartment, onSuccess: refresh });

  return <div className="p-6 max-w-6xl mx-auto space-y-6">
    <div><h2 className="text-xl font-semibold flex items-center gap-2"><Building2 size={22} />{t('departments.title')}</h2><p className="text-sm text-[var(--t-text-2)] mt-1">{t('departments.subtitle')}</p></div>
    <Card className="p-4 flex gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('departments.name')} aria-label={t('departments.name')} />
      <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ name: name.trim() })}><Plus size={16} />{t('departments.create')}</Button>
    </Card>
    {isLoading ? <p>{t('common.loading')}</p> : data.length === 0 ? <p>{t('departments.empty')}</p> : <div className="grid gap-4 md:grid-cols-2">
      {data.map((department) => <Card key={department.id} className="p-4 space-y-3">
        {editing === department.id ? <Input autoFocus defaultValue={department.name} onBlur={(e) => { update.mutate({ id: department.id, data: { name: e.target.value } }); setEditing(null); }} aria-label={t('departments.name')} /> : <div className="flex items-center justify-between"><h3 className="font-semibold cursor-pointer" onClick={() => setEditing(department.id)}>{department.name}</h3>{department.id !== 'chung' && <Button variant="ghost" onClick={() => { if (window.confirm(t('departments.confirmDelete'))) remove.mutate(department.id); }} aria-label={t('departments.delete')}><Trash2 size={16} /></Button>}</div>}
        <div className="grid grid-cols-3 gap-2 text-sm"><label>{t('departments.priority')}<Input type="number" defaultValue={department.priority} onBlur={(e) => update.mutate({ id: department.id, data: { priority: Number(e.target.value) } })} /></label><label>{t('departments.maxParallel')}<Input type="number" min="1" defaultValue={department.maxParallel} onBlur={(e) => update.mutate({ id: department.id, data: { maxParallel: Number(e.target.value) } })} /></label><label>{t('departments.budget')}<Input type="number" min="0" defaultValue={department.claudeDailyTokenBudget} onBlur={(e) => update.mutate({ id: department.id, data: { claudeDailyTokenBudget: Number(e.target.value) } })} /></label></div>
        <div className="text-sm text-[var(--t-text-2)]"><div>{t('departments.projects')}: {department.projects.map((project) => project.name).join(', ') || '—'}</div><div>{t('departments.profiles')}: {department.profiles.map((profile) => profile.profileName).join(', ') || '—'}</div></div>
      </Card>)}
    </div>}
  </div>;
};

export default DepartmentsPage;
