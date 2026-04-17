import { useCallback, useMemo, useRef, useState } from 'react';

export interface TableRow {
  id: string;
  label: string;
  value: number;
}

export interface TableState {
  rows: TableRow[];
  sortBy: keyof TableRow | null;
  sortDir: 'asc' | 'desc';
  selectedId: string | null;
  version: number;
}

export interface CanonicalDataTable {
  state: TableState;
  addRow: (label: string, value: number) => void;
  removeRow: (id: string) => void;
  selectRow: (id: string) => void;
  setSort: (key: keyof TableRow | null, dir?: 'asc' | 'desc') => void;
  bump: () => void;
}

const INITIAL: TableState = {
  rows: [],
  sortBy: null,
  sortDir: 'asc',
  selectedId: null,
  version: 0,
};

function sortRows(
  rows: TableRow[],
  sortBy: keyof TableRow | null,
  dir: 'asc' | 'desc',
): TableRow[] {
  if (!sortBy) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return dir === 'asc' ? cmp : -cmp;
  });
  return copy;
}

let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `row-${idCounter}`;
}

export function useCanonicalData(): CanonicalDataTable {
  const [state, setState] = useState<TableState>(INITIAL);
  const versionRef = useRef(0);

  const addRow = useCallback((label: string, value: number) => {
    const id = nextId();
    setState((prev) => ({
      ...prev,
      rows: sortRows(
        [...prev.rows, { id, label, value }],
        prev.sortBy,
        prev.sortDir,
      ),
    }));
  }, []);

  const removeRow = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      rows: prev.rows.filter((r) => r.id !== id),
      selectedId: prev.selectedId === id ? null : prev.selectedId,
    }));
  }, []);

  const selectRow = useCallback((id: string) => {
    setState((prev) => ({ ...prev, selectedId: id }));
  }, []);

  const setSort = useCallback(
    (key: keyof TableRow | null, dir: 'asc' | 'desc' = 'asc') => {
      setState((prev) => ({
        ...prev,
        sortBy: key,
        sortDir: dir,
        rows: sortRows(prev.rows, key, dir),
      }));
    },
    [],
  );

  const bump = useCallback(() => {
    const next = versionRef.current + 1;
    versionRef.current = next;
    setState((prev) => ({ ...prev, version: next }));
  }, []);

  return useMemo<CanonicalDataTable>(
    () => ({ state, addRow, removeRow, selectRow, setSort, bump }),
    [state, addRow, removeRow, selectRow, setSort, bump],
  );
}
