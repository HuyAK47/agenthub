import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Trash2 } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { createDepartment, deleteDepartment, getDepartments, getProfiles, updateDepartment, updateDepartmentProfiles } from '../api/client';
import { useLocale } from '../context/LocaleContext';

export const DepartmentsPage: React.FC = () => {
  const { t } = useLocale();
  const client = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ['departments'], queryFn: getDepartments });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [brainEngines, setBrainEngines] = useState<Record<string, 'claude' | 'codex'>>({});
  const refresh = () => client.invalidateQueries({ queryKey: ['departments'] });
  const create = useMutation({ mutationFn: createDepartment, onSuccess: () => { setName(''); refresh(); } });
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: object }) => updateDepartment(id, data), onSuccess: refresh });
  const updateProfiles = useMutation({ mutationFn: ({ id, profiles }: { id: string; profiles: { profileName: string; share: null }[] }) => updateDepartmentProfiles(id, profiles), onSuccess: refresh });
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
        <div className="grid grid-cols-3 gap-2 text-sm"><label>{t('departments.priority')}<Input type="number" defaultValue={department.priority} onBlur={(e) => update.mutate({ id: department.id, data: { priority: Number(e.target.value) } })} /></label><label>{t('departments.maxParallel')}<Input type="number" min="0" defaultValue={department.maxParallel} onBlur={(e) => update.mutate({ id: department.id, data: { maxParallel: Number(e.target.value) } })} /><span className="text-xs text-[var(--t-text-3)]">{t('departments.maxParallelHint')}</span></label><label>{t('departments.budget')}<Input type="number" min="0" defaultValue={department.claudeDailyTokenBudget} onBlur={(e) => update.mutate({ id: department.id, data: { claudeDailyTokenBudget: Number(e.target.value) } })} /></label></div>
        <div className="space-y-2 text-sm text-[var(--t-text-2)]">
          <div>{t('departments.projects')}: {department.projects.map((project) => project.name).join(', ') || '—'}</div>
          <div>
            <div>{t('departments.profiles')}: {department.profiles.map((profile) => profile.profileName).join(', ') || '—'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 mt-1">
              {profiles.map((profile) => {
                const checked = department.profiles.some((item) => item.profileName === profile.name);
                return <label key={profile.name} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={checked} onChange={(event) => {
                    const selected = new Set(department.profiles.map((item) => item.profileName));
                    if (event.target.checked) selected.add(profile.name); else selected.delete(profile.name);
                    updateProfiles.mutate({ id: department.id, profiles: [...selected].map((profileName) => ({ profileName, share: null })) });
                  }} />
                  {profile.name}
                </label>;
              })}
            </div>
          </div>
        </div>
        <details className="border-t border-[var(--t-border)] pt-3">
          <summary className="cursor-pointer text-sm font-semibold">{t('departments.brainSettings')}</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs">
            <label>{t('departments.brainEngine')}<select value={brainEngines[department.id] ?? department.brainEngine ?? 'claude'} onChange={(e) => { const brainEngine = e.target.value as 'claude' | 'codex'; setBrainEngines((current) => ({ ...current, [department.id]: brainEngine })); update.mutate({ id: department.id, data: { brainEngine } }); }} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
            <label>{t('departments.brainModel')}<Input defaultValue={department.brainModel ?? ''} onBlur={(e) => { const brainModel = e.target.value.trim(); if (brainModel) update.mutate({ id: department.id, data: { brainModel } }); }} /></label>
            {(brainEngines[department.id] ?? department.brainEngine) === 'codex' && <label>{t('departments.brainCodexProfile')}<Input defaultValue={department.brainCodexProfile ?? ''} onBlur={(e) => update.mutate({ id: department.id, data: { brainCodexProfile: e.target.value.trim() || null } })} /></label>}
            <label>{t('departments.brainMode')}<select defaultValue={department.brainMode ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainMode: e.target.value as 'inherit' | 'off' | 'suggest' | 'auto' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="off">{t('departments.off')}</option><option value="suggest">{t('departments.suggest')}</option><option value="auto">{t('departments.auto')}</option></select></label>
            <label>{t('departments.brainPermissions')}<select defaultValue={department.brainPermissions ?? 'inherit'} onChange={(e) => update.mutate({ id: department.id, data: { brainPermissions: e.target.value as 'inherit' | 'standard' | 'trusted' | 'full' } })} className="w-full rounded border p-2 bg-[var(--t-surface-2)]"><option value="inherit">{t('departments.inherit')}</option><option value="standard">Standard</option><option value="trusted">Trusted</option><option value="full">Full</option></select></label>
            <label>{t('departments.brainDailyTokenBudget')}<Input type="number" min="0" defaultValue={department.brainDailyTokenBudget || ''} onBlur={(e) => update.mutate({ id: department.id, data: { brainDailyTokenBudget: e.target.value ? Number(e.target.value) : undefined } })} /></label>
            <label>{t('departments.brainMaxTurnsPerHour')}<Input type="number" min="1" defaultValue={department.brainMaxTurnsPerHour || ''} onBlur={(e) => update.mutate({ id: department.id, data: { brainMaxTurnsPerHour: e.target.value ? Number(e.target.value) : undefined } })} /></label>
          </div>
        </details>
      </Card>)}
    </div>}
  </div>;
};

export default DepartmentsPage;
