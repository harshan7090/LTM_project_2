export type RiskBand = 'critical' | 'elevated' | 'normal';
export type Role = 'inspector' | 'supervisor' | 'admin';

export interface Me {
  name: string;
  role: Role;
  region: string | null;
}

export interface LoginResponse extends Me {
  token: string;
}

export type ConsequenceBand = 'high' | 'medium' | 'low';

export interface Segment {
  segment_id: string;
  region: string;
  predicted_rate_mpy: number;
  /** Likelihood x consequence, 0-100. This is what the register ranks on. */
  risk_score: number;
  /** Band of risk_score — NOT of the corrosion rate. */
  risk_band: RiskBand;
  /** Band of the corrosion rate alone. Kept separate so the console can show
   *  why a slow-corroding segment outranks a fast one. */
  likelihood_band: RiskBand;
  consequence_score: number;
  consequence_band: ConsequenceBand;
  is_hca: boolean;
  last_inspection_years_ago: number;
  acknowledged: boolean;
  /** Fleet percentile rank of the predicted rate, 0-1. This is the matrix's
   *  likelihood axis, carried on the row so the client can bin without a
   *  second request. */
  likelihood_pct: number;
  /** Null for a segment with no recorded position - the map skips those
   *  rather than dropping them at (0, 0) off the coast of Africa. */
  latitude: number | null;
  longitude: number | null;
}

/** One cell of the 5x5. `sample_ids` is a sample, not the population: a busy
 *  cell holds a thousand segments and the click-through only needs enough to
 *  fill the register. */
export interface RiskCell {
  likelihood: number;       // 1-5, row
  consequence: number;      // 1-5, column
  count: number;
  band: 'low' | 'moderate' | 'high' | 'severe';
  sample_ids: string[];
  hca_count: number;
}

export interface RiskMatrix {
  /** Row-major, likelihood 5 -> 1, so index 0 is the top-left of the grid as
   *  drawn. Always 25 entries - an empty cell is information. */
  cells: RiskCell[];
  likelihood_labels: string[];
  consequence_labels: string[];
  band_counts: Record<string, number>;
  total: number;
  max_cell: number;
}

/** One pipeline corridor. `path` is [lat, lon] in flow order — the same
 *  waypoints the segments were placed on, served by the backend so the two
 *  cannot drift apart. */
export interface PipelineRoute {
  name: string;
  region: string;
  weight: number;
  length_km: number;
  path: [number, number][];
}

/** What the console needs to draw a basemap. Carries no key: tiles are
 *  relayed by the backend so the credential never reaches the browser. */
export interface MapConfig {
  provider: string;
  style: string;
  available: boolean;
  attribution: string;
  min_zoom: number;
  max_zoom: number;
  tile_size: number;
}

export interface SegmentHistory {
  segment_id: string;
  series: number[];
  /** Always true today. The series is back-cast from the current rate under
   *  the model's own sqrt(age) relationship, not measured - the UI has to say
   *  so rather than implying there is inspection history behind it. */
  reconstructed: boolean;
}

export interface ConsequenceAssessment {
  segment_id: string;
  consequence_score: number;
  consequence_band: ConsequenceBand;
  is_hca: boolean;
  hca_basis: string[];
  potential_impact_radius_ft: number | null;
  drivers: string[];
  regulatory_regime: string;
}

export interface RemainingLife {
  segment_id: string;
  applicable: boolean;
  reason: string;
  grade: string;
  smys_psi: number;
  design_factor: number;
  current_wall_in: number;
  current_wall_mm: number;
  min_required_wall_in: number;
  min_required_wall_mm: number;
  corrosion_allowance_in: number;
  corrosion_rate_mpy: number;
  remaining_life_years: number | null;
  half_life_years: number | null;
  safe_operating_pressure_psi: number;
  operating_pressure_psi: number;
  erf: number | null;
  verdict: 'monitor' | 'plan_repair' | 'repair_now' | 'derate' | '';
  drivers: string[];
  notes: string[];
}

export interface ShapContribution {
  feature: string;
  impact_mpy: number;
}

export interface SegmentDetail extends Segment {
  attributes: Record<string, string | number | boolean>;
  explanation: {
    base_value: number;
    contributions: ShapContribution[];
  };
  consequence: ConsequenceAssessment;
  remaining_life: RemainingLife;
  repair: RepairPlan;
  acknowledged_by?: { by: string; at: string } | null;
}

/** The detail endpoint returns `acknowledged` as an object, unlike the list
 *  endpoint where it's a boolean. Modelled separately rather than papered over. */
export interface SegmentDetailRaw extends Omit<SegmentDetail, 'acknowledged'> {
  acknowledged: { by: string; at: string } | null;
}

export interface InspectionMethod {
  code: string;
  name: string;
  category: 'indirect' | 'direct' | 'in-line' | 'pressure';
  priority: number;
  rationale: string;
  /** One line, for the collapsed view. */
  summary: string;
  standard: string;
  est_days: number;
  /** Diagnostic value 0-1: how much this tells you about the threat. */
  value: number;
  /** value / crew-days. The list is sorted on this, descending. */
  efficiency: number;
}

export interface InspectionPlan {
  segment_id: string;
  risk_band: RiskBand;
  urgency: 'immediate' | 'scheduled' | 'routine';
  interval_months: number;
  /** Statutory ceiling (49 CFR 192.939 / 195.452). Null outside an HCA. */
  regulatory_deadline_months: number | null;
  is_hca: boolean;
  /** Top three by efficiency. */
  methods: InspectionMethod[];
  /** Triggered but ranked lower. Kept so "why no ILI run?" has an answer. */
  also_considered: InspectionMethod[];
  drivers: string[];
  total_est_days: number;
  notes: string[];
}

export interface FleetStats {
  total_segments: number;
  risk_band_counts: Record<RiskBand, number>;
  likelihood_band_counts: Record<RiskBand, number>;
  consequence_band_counts: Record<ConsequenceBand, number>;
  hca_segments: number;
  hca_pct: number;
  avg_predicted_rate_by_region: Record<string, number>;
  histogram: { counts: number[]; bin_edges: number[] };
}

export interface KnowledgeStats {
  documents: number;
  chunks: number;
  dense_enabled: boolean;
  dense_model: string | null;
  directory: string;
}

export interface AssistantStatus {
  provider: string;
  available: boolean;
  model: string | null;
  supports_vision: boolean;
  detail: string;
  models: string[];
  knowledge_base: KnowledgeStats;
  /** Vision may come from a different backend than text — e.g. local Ollama
   *  sees the image while Groq writes the assessment. */
  vision_provider: string | null;
  vision_model: string | null;
  vision_detail: string;
}

export interface Citation {
  citation: string;
  score: number;
}

export interface KnowledgeHit extends Citation {
  doc_id: string;
  section: string;
  text: string;
}

export interface ScheduleAssignment {
  segment_id: string;
  region: string;
  risk_band: RiskBand;
  predicted_rate_mpy: number;
  est_days: number;
  methods: string[];
  crew_id: string;
  crew_name: string;
  period: number;
}

export interface CrewLoad {
  crew_id: string;
  name: string;
  region: string | null;
  days_available: number;
  days_used: number;
  segments: number;
}

export interface OversizedSegment {
  segment_id: string;
  region: string;
  est_days: number;
  max_crew_days: number;
  reason: string;
}

export interface ScheduleResult {
  status: string;
  optimal: boolean;
  periods: number;
  assignments: ScheduleAssignment[];
  scheduled_count: number;
  oversized: OversizedSegment[];
  warnings: string[];
  total_days_used: number;
  total_days_available: number;
  utilization_pct: number;
  risk_covered_mpy: number;
  risk_total_mpy: number;
  risk_coverage_pct: number;
  unscheduled_critical: number;
  /** Segments whose statutory reassessment deadline the schedule misses.
   *  A compliance breach, not a prioritisation outcome. */
  missed_deadlines: MissedDeadline[];
  hca_total: number;
  hca_scheduled: number;
  hca_coverage_pct: number;
  solve_ms: number;
  crews: CrewLoad[];
  message: string;
}

export interface MissedDeadline {
  segment_id: string;
  region: string;
  deadline_period: number | null;
  risk_band: RiskBand;
  est_days: number;
}

export interface ScheduleRequest {
  periods: number;
  days_per_period: number;
  crews_per_region: number;
  candidate_limit: number;
  region_locked: boolean;
  risk_bands: RiskBand[];
}

export interface ImageAnalysis {
  segment_id: string | null;
  /** Stage 2: the structured engineering assessment, written by the text model. */
  analysis: string;
  /** Stage 1: raw visual description from the vision model, surfaced so the
   *  engineer can see what was actually observed vs. what was inferred. */
  observations: string;
  provider: string;
  model: string | null;
  vision_provider: string;
  vision_model: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  error?: boolean;
}

// ---------------------------------------------------------------- repair --

export type RepairUrgency = 'immediate' | 'scheduled' | 'routine' | 'monitor';

export interface RepairAction {
  code: string;
  name: string;
  category: 'reinforcement' | 'mitigation' | 'operational' | 'replacement';
  priority: number;
  rationale: string;
  standard: string;
  est_days: number;
  est_cost_usd: number;
  requires_shutdown: boolean;
  skill: string;
  summary: string;
  value: number;
  efficiency: number;
  total_burden_days: number;
}

export interface RepairPlan {
  segment_id: string;
  urgency: RepairUrgency;
  window_days: number;
  actions: RepairAction[];
  also_considered: RepairAction[];
  drivers: string[];
  notes: string[];
  total_est_days: number;
  total_est_cost_usd: number;
  requires_shutdown: boolean;
  skills_required: string[];
}

// ----------------------------------------------------------- work orders --

export type WorkOrderStatus =
  | 'unassigned' | 'assigned' | 'in_progress' | 'complete' | 'blocked';

export interface WorkOrder {
  order_id: string;
  segment_id: string;
  region: string;
  latitude: number;
  longitude: number;
  urgency: RepairUrgency;
  window_days: number;
  est_days: number;
  risk_score: number;
  skills_required: string[];
  actions: string[];
  is_hca: boolean;
  status: WorkOrderStatus;
  assigned_to: string | null;
  travel_km: number;
  travel_days: number;
  total_days: number;
}

export interface TechnicianLoad {
  tech_id: string;
  name: string;
  region: string | null;
  skills: string[];
  days_available: number;
  work_days: number;
  travel_days: number;
  travel_km: number;
  days_used: number;
  utilization_pct: number;
  orders: number;
}

export interface SkillGap {
  order_id: string;
  segment_id: string;
  region: string;
  missing_skills: string[];
  urgency: RepairUrgency;
}

export interface CapacityGap {
  region: string;
  skill: string;
  orders: number;
  urgent: number;
  work_days: number;
  travel_days: number;
  needed_days: number;
  available_days: number;
  technicians: number;
  shortfall_days: number;
  oversubscribed: boolean;
}

export interface AssignmentResult {
  status: string;
  optimal: boolean;
  orders: WorkOrder[];
  technicians: TechnicianLoad[];
  solve_ms: number;
  assigned_count: number;
  unassigned_count: number;
  unassigned_immediate: number;
  total_travel_km: number;
  total_work_days: number;
  total_travel_days: number;
  travel_share_pct: number;
  risk_covered: number;
  risk_total: number;
  risk_coverage_pct: number;
  skill_gaps: SkillGap[];
  /** True when urgent work could not all be covered and the requirement was
   *  relaxed to produce any schedule at all. */
  relaxed_immediate: boolean;
  capacity_gaps: CapacityGap[];
  warnings: string[];
  message: string;
}

export interface WorkOrderRequest {
  candidate_limit: number;
  days_available: number;
  travel_penalty_per_day: number;
  risk_bands: RiskBand[];
  require_immediate: boolean;
  regions?: string[] | null;
}
