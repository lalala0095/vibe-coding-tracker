// Invoices — the list.
//
// A tab rather than a row on More: invoicing is what the tracked hours are for.
//
// ── Money on this screen ─────────────────────────────────────────────────────
//
// None is computed here. Every figure a row prints — `total`, `total_hours`,
// `amount_paid`, `outstanding` — was computed by the server on write and is
// rendered as it arrived. `src/lib/money.ts` exists for live totals *while
// editing*, which is the detail screen's job, not this one's.
//
// ── Filtering ────────────────────────────────────────────────────────────────
//
// Status and client go to the server as query params and the list is re-fetched
// when either moves. That is the opposite of `app/trackers.tsx`, which pulls
// everything once and filters on the phone — and deliberately so: trackers are
// a working set, invoices are an archive that only ever grows.

import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { apiErrorMessage, getClients, getInvoices } from '@/api';
import { Button, EmptyState, ErrorNote, LoadingBlock, Screen } from '@/components';
import CreateInvoiceSheet from '@/screens/invoices/create/CreateInvoiceSheet';
import InvoiceFilters from '@/screens/invoices/list/InvoiceFilters';
import InvoiceRow from '@/screens/invoices/list/InvoiceRow';
import { sortByIssueDesc, type StatusFilter } from '@/screens/invoices/list/invoiceRows';
import type { Client, Invoice } from '@/types';

export default function InvoicesScreen() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [status, setStatus] = useState<StatusFilter>('all');
  const [clientId, setClientId] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);

  // ── Fetching ─────────────────────────────────────────────────────────────

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      setError('');
      try {
        setInvoices(
          sortByIssueDesc(
            await getInvoices({
              // Omitted rather than sent as a sentinel: "all" is the absence of
              // the filter, not a value the endpoint knows.
              ...(status !== 'all' ? { status } : {}),
              ...(clientId !== null ? { client_id: clientId } : {}),
            }),
          ),
        );
      } catch (e: unknown) {
        setError(apiErrorMessage(e, 'Could not load invoices.'));
      } finally {
        setLoading(false);
      }
    },
    [status, clientId],
  );

  // Best-effort, like the settings fetch on the other screens: the client list
  // only powers a filter, and losing it must not cost the invoices themselves.
  const loadClients = useCallback(async () => {
    try {
      setClients(await getClients());
    } catch {
      setClients([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load({ silent: true }), loadClients()]);
    setRefreshing(false);
  }, [load, loadClients]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const open = (invoice: Invoice) => router.push(`/invoice/${invoice.id}`);

  /**
   * A new invoice lands in the list and then opens.
   *
   * The refresh is not awaited before pushing: the created invoice came back
   * whole from the server, so the detail screen has everything it needs, and
   * making the navigation wait on a second round trip would only add a pause.
   * The list is reloaded rather than spliced because the active filters may
   * exclude the new invoice, and a row that ignores the filter it is under
   * would be a lie.
   */
  const handleCreated = (invoice: Invoice) => {
    setCreating(false);
    load({ silent: true });
    open(invoice);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const filtered = status !== 'all' || clientId !== null;

  const header = (
    <View className="border-b border-slate-800 px-4 pb-3 pt-1">
      <Text className="text-xl font-bold text-slate-100">Invoices</Text>
      <Text className="mt-0.5 text-xs leading-relaxed text-slate-500">
        {invoices.length} {invoices.length === 1 ? 'invoice' : 'invoices'}
        {filtered ? ' matching' : ''}, newest first.
      </Text>

      <View className="mt-3">
        <InvoiceFilters
          status={status}
          onStatusChange={setStatus}
          clientId={clientId}
          onClientChange={setClientId}
          clients={clients}
        />
      </View>
    </View>
  );

  const footer = (
    <View className="border-t border-slate-800 px-4 py-3">
      <Button label="+ New invoice" onPress={() => setCreating(true)} testID="new-invoice" />
    </View>
  );

  return (
    <Screen header={header} footer={footer} refreshing={refreshing} onRefresh={handleRefresh}>
      {loading ? (
        <LoadingBlock label="Loading invoices…" />
      ) : error ? (
        <ErrorNote message={error} onRetry={() => load()} />
      ) : invoices.length === 0 ? (
        <EmptyState
          title={filtered ? 'Nothing matches' : 'No invoices yet'}
          subtitle={
            filtered
              ? 'Clear the status or client filter to see the rest.'
              : 'An invoice is built from a client’s time entries and trackers over a period. Start one and pick what to bill.'
          }
          actionLabel={filtered ? undefined : 'New invoice'}
          onAction={filtered ? undefined : () => setCreating(true)}
        />
      ) : (
        <View className="gap-3">
          {invoices.map((invoice) => (
            <InvoiceRow key={invoice.id} invoice={invoice} onPress={() => open(invoice)} />
          ))}
        </View>
      )}

      {/*
        Mounted only while open, so each opening starts clean — the same pattern
        the tracker sheets use. The component is owned by another workstream and
        is imported against the agreed prop contract.
      */}
      {creating ? (
        <CreateInvoiceSheet
          visible
          onClose={() => setCreating(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </Screen>
  );
}
