export type ScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

export interface Paginated<T> {
  records: T[];
  next_token?: string | null;
}

export interface UserProfile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}

export interface BodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

export interface CycleScore {
  strain: number;
  kilojoule: number;
  average_heart_rate: number;
  max_heart_rate: number;
}

export interface Cycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string | null;
  timezone_offset: string;
  score_state: ScoreState;
  score?: CycleScore | null;
  step_count?: number | null;
}

export interface RecoveryScore {
  user_calibrating: boolean;
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number | null;
  skin_temp_celsius?: number | null;
}

export interface Recovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: ScoreState;
  score?: RecoveryScore | null;
}

export interface SleepStageSummary {
  total_in_bed_time_milli: number;
  total_awake_time_milli: number;
  total_no_data_time_milli: number;
  total_light_sleep_time_milli: number;
  total_slow_wave_sleep_time_milli: number;
  total_rem_sleep_time_milli: number;
  sleep_cycle_count: number;
  disturbance_count: number;
}

export interface SleepNeeded {
  baseline_milli: number;
  need_from_sleep_debt_milli: number;
  need_from_recent_strain_milli: number;
  need_from_recent_nap_milli: number;
}

export interface SleepScore {
  stage_summary: SleepStageSummary;
  sleep_needed: SleepNeeded;
  respiratory_rate?: number | null;
  sleep_performance_percentage?: number | null;
  sleep_consistency_percentage?: number | null;
  sleep_efficiency_percentage?: number | null;
}

export interface Sleep {
  id: string;
  v1_id?: number | null;
  cycle_id?: number | null;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: ScoreState;
  score?: SleepScore | null;
}

export interface ZoneDurations {
  zone_zero_milli: number;
  zone_one_milli: number;
  zone_two_milli: number;
  zone_three_milli: number;
  zone_four_milli: number;
  zone_five_milli: number;
}

export interface WorkoutScore {
  strain: number;
  average_heart_rate: number;
  max_heart_rate: number;
  kilojoule: number;
  percent_recorded: number;
  distance_meter?: number | null;
  altitude_gain_meter?: number | null;
  altitude_change_meter?: number | null;
  zone_durations?: ZoneDurations | null;
}

export interface Workout {
  id: string;
  v1_id?: number | null;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_name?: string | null;
  sport_id?: number | null;
  score_state: ScoreState;
  score?: WorkoutScore | null;
}
