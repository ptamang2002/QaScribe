import axios from 'axios';
import type {
  AggregatedArtifactItem, Artifact, ArtifactListResponse, ArtifactStats,
  BudgetStatus, CostEstimate, CoverageRollupResponse, DashboardStats,
  ListArtifactsParams, ModelConfig, ReviewStatus, SessionListItem,
  SessionStatusResponse, UserMe, WorkflowResponse,
} from '../types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
});

// ---- Sessions ----

export async function estimateSession(file: File): Promise<CostEstimate> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/api/sessions/estimate', form);
  return data;
}

export async function createSession(
  title: string,
  testFocus: string,
  file: File | Blob,
  filename = 'recording.mp4',
): Promise<{ session_id: string; status: string; estimated_cost_usd: number }> {
  const form = new FormData();
  form.append('title', title);
  form.append('test_focus', testFocus);
  form.append('file', file, filename);
  const { data } = await api.post('/api/sessions', form);
  return data;
}

export async function listSessions(limit?: number): Promise<SessionListItem[]> {
  const { data } = await api.get('/api/sessions', {
    params: limit !== undefined ? { limit } : undefined,
  });
  return data;
}

export async function getSessionStatus(id: string): Promise<SessionStatusResponse> {
  const { data } = await api.get(`/api/sessions/${id}`);
  return data;
}

export async function retrySession(
  id: string,
): Promise<{ session_id: string; status: string; estimated_cost_usd: number }> {
  const { data } = await api.post(`/api/sessions/${id}/retry`);
  return data;
}

export async function getSessionVideoUrl(id: string): Promise<string> {
  const { data } = await api.get(`/api/sessions/${id}/video`);
  return data.url;
}

export async function getArtifacts(id: string): Promise<Artifact[]> {
  const { data } = await api.get(`/api/sessions/${id}/artifacts`);
  return data;
}

export async function updateArtifact(
  sessionId: string,
  artifactId: string,
  content: Record<string, unknown>,
): Promise<Artifact> {
  const { data } = await api.put(
    `/api/sessions/${sessionId}/artifacts/${artifactId}`,
    { content },
  );
  return data;
}

export async function deleteArtifact(
  sessionId: string,
  artifactId: string,
): Promise<void> {
  await api.delete(`/api/sessions/${sessionId}/artifacts/${artifactId}`);
}

export async function getWorkflow(id: string): Promise<WorkflowResponse> {
  const { data } = await api.get(`/api/sessions/${id}/workflow`);
  return data;
}

// ---- Dashboard / Budget ----

export async function getDashboardStats(): Promise<DashboardStats> {
  const { data } = await api.get('/api/sessions/dashboard/stats');
  return data;
}

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const { data } = await api.get('/api/sessions/budget/status');
  return data;
}

// ---- Config / User ----

export async function getModelConfig(): Promise<ModelConfig> {
  const { data } = await api.get('/api/config/models');
  return data;
}

export async function getMe(): Promise<UserMe> {
  const { data } = await api.get('/api/users/me');
  return data;
}

export async function updateMyBudget(monthly_budget_usd: number): Promise<UserMe> {
  const { data } = await api.patch('/api/users/me', { monthly_budget_usd });
  return data;
}

// ---- Cross-session artifacts ----

export async function listArtifacts(
  params: ListArtifactsParams,
): Promise<ArtifactListResponse> {
  const search: Record<string, string> = {};
  if (params.type) search.type = params.type;
  if (params.session_id) search.session_id = params.session_id;
  if (params.severity && params.severity.length > 0)
    search.severity = params.severity.join(',');
  if (params.priority && params.priority.length > 0)
    search.priority = params.priority.join(',');
  if (params.review_status) search.review_status = params.review_status;
  if (params.search) search.search = params.search;
  if (params.sort) search.sort = params.sort;
  if (params.page) search.page = String(params.page);
  if (params.page_size) search.page_size = String(params.page_size);
  const { data } = await api.get('/api/artifacts', { params: search });
  return data;
}

export async function getArtifactStats(): Promise<ArtifactStats> {
  const { data } = await api.get('/api/artifacts/stats');
  return data;
}

export async function getCoverageRollup(): Promise<CoverageRollupResponse> {
  const { data } = await api.get('/api/artifacts/coverage-rollup');
  return data;
}

export async function reviewArtifact(
  artifactId: string,
  body: { review_status: ReviewStatus; review_notes?: string },
): Promise<AggregatedArtifactItem> {
  const { data } = await api.patch(`/api/artifacts/${artifactId}/review`, body);
  return data;
}

// ---- Export ----

export type ExportArtifactType = 'bugs' | 'test_cases' | 'coverage_gaps';
export type ExportFormat = 'json' | 'csv';
export type ValidationType = 'application' | 'browser-native' | 'server-side';

export interface ExportFilters {
  session_id?: string;
  date_from?: string;
  date_to?: string;
  review_status?: ReviewStatus[];
  severity?: import('../types').Severity[];
  // Bugs use P1–P4; coverage_gap.priority is severity-style. Backend validates
  // per type — keep this loose so callers don't need to cast.
  priority?: (import('../types').Priority | import('../types').Severity)[];
  validation_type?: ValidationType[];
}

function exportSearchParams(filters: ExportFilters): Record<string, string> {
  const search: Record<string, string> = {};
  if (filters.session_id) search.session_id = filters.session_id;
  if (filters.date_from) search.date_from = filters.date_from;
  if (filters.date_to) search.date_to = filters.date_to;
  if (filters.review_status?.length)
    search.review_status = filters.review_status.join(',');
  if (filters.severity?.length) search.severity = filters.severity.join(',');
  if (filters.priority?.length) search.priority = filters.priority.join(',');
  if (filters.validation_type?.length)
    search.validation_type = filters.validation_type.join(',');
  return search;
}

export async function exportArtifacts(
  artifactType: ExportArtifactType,
  format: ExportFormat,
  filters: ExportFilters,
): Promise<{ blob: Blob; filename: string }> {
  const { data, headers } = await api.get(
    `/api/export/${artifactType}/${format}`,
    { params: exportSearchParams(filters), responseType: 'blob' },
  );
  const cd = (headers['content-disposition'] as string | undefined) ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const today = new Date().toISOString().slice(0, 10);
  const filename = match?.[1] ?? `qascribe-${artifactType}-${today}.${format}`;
  return { blob: data as Blob, filename };
}

export async function getExportCount(
  artifactType: ExportArtifactType,
  filters: ExportFilters,
): Promise<number> {
  const { data } = await api.get(`/api/export/${artifactType}/count`, {
    params: exportSearchParams(filters),
  });
  return data.count as number;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
