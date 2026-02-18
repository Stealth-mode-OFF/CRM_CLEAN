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
};

export type PipedriveLead = {
  id: string;
  title?: string;
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
  deal_id?: number | null;
  lead_id?: string | null;
};

export type PipedriveNote = {
  id: number;
  content?: string;
  add_time?: string;
};

export type PipedrivePerson = {
  id: number;
  name?: string;
  email?: Array<{ value?: string }>;
  org_id?: number | null;
};

export type PipedriveOrg = {
  id: number;
  name?: string;
  address?: string;
  owner_id?: number;
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
