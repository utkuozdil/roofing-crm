import type { LeadRecord, LeadStatus } from '@roofing-crm/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * Lead CRUD against the tRPC API.
 *
 * Owned once at the application root and shared by both views, so a lead created from the
 * map detail panel appears in the pipeline without a manual refresh, and a status change in
 * the pipeline is reflected in the map's "already a lead" hint.
 *
 * Mutations are NOT applied optimistically. An optimistic row looks committed the instant
 * it is clicked, which hides in-flight work: a reload landing on top of a pending request
 * silently discards it, and the user has no way to tell a saved change from a lost one.
 * Instead each row carries a visible save state and the list only ever shows what the API
 * confirmed.
 */

export type MutationStatus = 'idle' | 'saving' | 'created' | 'error';

export interface LeadCreateState {
  status: MutationStatus;
  message: string | null;
}

/** Per-row save state, keyed by lead id, so one slow row never blocks the whole table. */
export type LeadSaveState = 'saving' | 'saved' | 'error';

const IDLE: LeadCreateState = { status: 'idle', message: null };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CreateLeadArgs {
  parcelId: string;
  ownerName: string;
  primaryAddress: string;
  roofAgeYears: number | null;
  latitude?: number | null;
  longitude?: number | null;
  permitCount?: number;
  unresolvedPermitCount?: number;
  unresolvedRoofingCount?: number;
  longestOpenYears?: number | null;
  source: string;
  notes: string;
}

export function useLeads() {
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createState, setCreateState] = useState<LeadCreateState>(IDLE);
  const [saveStates, setSaveStates] = useState<Record<string, LeadSaveState>>({});

  const markSaveState = useCallback((leadId: string, state: LeadSaveState) => {
    setSaveStates((current) => ({ ...current, [leadId]: state }));
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const page = await api.leads.list.query({ limit: 100 });
      setLeads(page.items);
      setError(null);
    } catch (caught) {
      setError(`Could not load leads: ${describe(caught)}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (args: CreateLeadArgs) => {
    setCreateState({ status: 'saving', message: null });
    try {
      const lead = await api.leads.create.mutate(args);
      // Prepend only a new id. A second click on the same parcel returns the existing row.
      const alreadySaved = leads.some(
        (row) => row.leadId === lead.leadId || row.parcelId === lead.parcelId,
      );
      setLeads((current) => {
        if (current.some((row) => row.leadId === lead.leadId || row.parcelId === lead.parcelId)) {
          return current.map((row) =>
            row.leadId === lead.leadId || row.parcelId === lead.parcelId ? lead : row,
          );
        }
        return [lead, ...current];
      });
      setCreateState({
        status: 'created',
        message: alreadySaved
          ? `Already a lead for ${lead.primaryAddress}. See it in Lead pipeline.`
          : `Lead created for ${lead.primaryAddress}. See it in Lead pipeline.`,
      });
    } catch (caught) {
      setCreateState({ status: 'error', message: `Could not create lead: ${describe(caught)}` });
    }
  }, [leads]);

  const updateStatus = useCallback(
    async (leadId: string, status: LeadStatus) => {
      markSaveState(leadId, 'saving');
      try {
        const updated = await api.leads.updateStatus.mutate({ leadId, status });
        setLeads((current) =>
          current.map((lead) =>
            lead.leadId === leadId
              ? { ...lead, status: updated.status, updatedAt: updated.updatedAt }
              : lead,
          ),
        );
        markSaveState(leadId, 'saved');
        setError(null);
      } catch (caught) {
        markSaveState(leadId, 'error');
        setError(`Could not update lead: ${describe(caught)}`);
      }
    },
    [markSaveState],
  );

  const remove = useCallback(
    async (leadId: string) => {
      markSaveState(leadId, 'saving');
      try {
        await api.leads.delete.mutate({ leadId });
        setLeads((current) => current.filter((lead) => lead.leadId !== leadId));
        setSaveStates((current) => {
          const next = { ...current };
          delete next[leadId];
          return next;
        });
        setError(null);
      } catch (caught) {
        markSaveState(leadId, 'error');
        setError(`Could not delete lead: ${describe(caught)}`);
      }
    },
    [markSaveState],
  );

  const resetCreateState = useCallback(() => setCreateState(IDLE), []);

  return {
    leads,
    isLoading,
    error,
    createState,
    saveStates,
    refresh,
    create,
    updateStatus,
    remove,
    resetCreateState,
  };
}
