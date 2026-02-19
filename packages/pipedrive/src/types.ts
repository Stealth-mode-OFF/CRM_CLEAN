export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
};

export type PipedriveEnvelope<T> = {
  success?: boolean;
  data: T;
  additional_data?: {
    next_cursor?: string | null;
    pagination?: {
      start: number;
      limit: number;
      more_items_in_collection: boolean;
      next_start?: number;
    };
  };
};

export type PipedriveDeal = {
  id: number;
  title?: string;
  status?: string;
  stage_id?: number;
  pipeline_id?: number;
  value?: number;
  add_time?: string;
  update_time?: string;
  stage_change_time?: string;
  won_time?: string;
  lost_time?: string;
  close_time?: string;
  lost_reason?: string | null;
  person_id?: number | { value: number } | null;
  org_id?: number | { value: number } | null;
};

export type PipedriveLead = {
  id: string;
  title?: string;
  add_time?: string;
  update_time?: string;
  person_id?: number | { value: number } | null;
  organization_id?: number | { value: number } | null;
  owner_id?: number | { value: number } | null;
  label_ids?: string[];
};

export type PipedriveActivity = {
  id: number;
  subject?: string;
  type?: string;
  done?: boolean;
  due_date?: string | null;
  due_time?: string | null;
  done_date?: string | null;
  add_time?: string | null;
  update_time?: string | null;
  deal_id?: number | null;
  lead_id?: string | null;
};

export type PipedriveNote = {
  id: number;
  content?: string;
  add_time?: string;
  user_id?: number;
};

export type PipedrivePerson = {
  id: number;
  name?: string;
  email?: Array<{ value?: string }>;
  phone?: Array<{ value?: string }>;
  org_id?: number | { value: number } | null;
  add_time?: string;
  update_time?: string;
};

export type PipedriveOrg = {
  id: number;
  name?: string;
  address?: string;
  owner_id?: number;
  website?: string | null;
  domain?: string | null;
  web?: string | null;
  add_time?: string;
  update_time?: string;
  [key: string]: unknown;
};

export type FieldMapEntityType = "deal" | "lead" | "person" | "org";

export type PipedriveField = {
  id: number;
  key: string;
  name: string;
  field_type?: string;
  options?: unknown;
};
