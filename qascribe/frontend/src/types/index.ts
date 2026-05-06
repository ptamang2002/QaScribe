export interface CostBreakdown {
  gemini_usd: number;
  stt_usd: number;
  claude_usd: number;
}

export interface CostEstimate {
  duration_seconds: number;
  has_voice_track: boolean;
  estimated_cost_usd: number;
  estimated_cost_with_safety_margin_usd: number;
  breakdown: CostBreakdown;
  would_exceed_per_job_cap: boolean;
  user_monthly_budget_remaining_usd: number;
}

export type SessionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rejected_budget';

export interface SessionStatusResponse {
  session_id: string;
  title: string;
  test_focus: string;
  status: SessionStatus;
  duration_seconds: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  error_message: string | null;
  has_voice_track: boolean;
  created_at: string;
  artifact_counts: {
    test_case: number;
    bug_report: number;
    coverage_gap: number;
  };
}

export interface SessionListItem {
  session_id: string;
  title: string;
  test_focus: string;
  status: SessionStatus;
  duration_seconds: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  artifact_count: number;
  created_at: string;
}

export type ArtifactType = 'test_case' | 'bug_report' | 'coverage_gap';

export type ReviewStatus =
  | 'unreviewed'
  | 'confirmed'
  | 'dismissed'
  | 'needs_more_info';

export interface Artifact {
  id: string;
  artifact_type: ArtifactType;
  content: Record<string, unknown>;
  user_edited: boolean;
  created_at: string;
  review_status: ReviewStatus;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  review_notes: string | null;
}

export interface BudgetStatus {
  user_id: string;
  monthly_budget_usd: number;
  month_to_date_spend_usd: number;
  remaining_usd: number;
  global_today_spend_usd: number;
  global_daily_cap_usd: number;
}

export type StepKind = 'action' | 'voice_annotation' | 'anomaly';

export interface WorkflowStep {
  step_number: number;
  timestamp_seconds: number;
  kind: StepKind;
  summary: string;
  details: string;
  linked_artifact_ids: string[];
}

export interface WorkflowResponse {
  session_id: string;
  duration_seconds: number;
  steps: WorkflowStep[];
}

export interface DashboardStats {
  sessions_this_month: number;
  test_cases_generated: number;
  bugs_surfaced: number;
  estimated_hours_saved: number;
}

export interface ModelConfig {
  gemini_model: string;
  stt_model: string;
  claude_model: string;
  gemini_input_price_per_m: number;
  gemini_output_price_per_m: number;
  stt_price_per_minute: number;
  claude_input_price_per_m: number;
  claude_output_price_per_m: number;
  per_job_max_usd: number;
  max_video_duration_seconds: number;
  max_video_file_size_mb: number;
}

export interface UserMe {
  id: string;
  email: string;
  monthly_budget_usd: number;
}

export interface RecordingSettings {
  resolution: '720p' | '1080p';
  frameRate: 15 | 30 | 60;
  audioBitrate: 64 | 128;
  preferMp4: boolean;
}

// ---- Cross-session artifacts ----

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type ArtifactSort =
  | 'created_desc'
  | 'created_asc'
  | 'severity_desc'
  | 'priority_desc';

export interface AggregatedArtifactItem {
  id: string;
  session_id: string;
  session_title: string;
  session_created_at: string;
  session_duration_seconds: number;
  artifact_type: ArtifactType;
  content: Record<string, unknown>;
  evidence_timestamps: string[];
  user_edited: boolean;
  created_at: string;
  review_status: ReviewStatus;
  reviewed_at: string | null;
  reviewed_by_user_id: string | null;
  review_notes: string | null;
}

export interface ArtifactListResponse {
  items: AggregatedArtifactItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface ArtifactStats {
  total_test_cases: number;
  total_bug_reports: number;
  total_coverage_gaps: number;
  bugs_by_severity: Record<Severity, number>;
  bugs_by_priority: Record<Priority, number>;
  bugs_by_review_status: Record<ReviewStatus, number>;
  open_high_severity_count: number;
  high_severity_confirmed_count: number;
  test_cases_user_edited_this_month: number;
  artifacts_created_last_7_days: Record<ArtifactType, number>;
}

export interface ListArtifactsParams {
  type?: ArtifactType;
  session_id?: string;
  severity?: Severity[];
  priority?: Priority[];
  review_status?: ReviewStatus;
  search?: string;
  sort?: ArtifactSort;
  page?: number;
  page_size?: number;
}

export interface CoverageRollupItem {
  title: string;
  description: string;
  occurrences: number;
  session_ids: string[];
  highest_priority: Severity;
  first_seen: string;
  latest_seen: string;
}

export interface CoverageRollupResponse {
  items: CoverageRollupItem[];
  total: number;
}
