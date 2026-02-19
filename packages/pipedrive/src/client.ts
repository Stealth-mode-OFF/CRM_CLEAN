import Bottleneck from "bottleneck";
import { dayKey, logger, stableHash } from "@autopilot/shared";
import type {
  HttpMethod,
  PipedriveActivity,
  PipedriveDeal,
  PipedriveEnvelope,
  PipedriveField,
  PipedriveLead,
  PipedriveNote,
  PipedriveOrg,
  PipedrivePerson,
  RequestOptions,
  FieldMapEntityType
} from "./types.js";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export type PipedriveClientConfig = {
  token: string;
  baseUrl?: string;
  maxConcurrent?: number;
  minTimeMs?: number;
  dailyMutationLimit?: number;
};

export class PipedriveClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly limiter: Bottleneck;
  private readonly dailyMutationLimit: number;
  private readonly mutationUsage = new Map<string, number>();

  constructor(config: PipedriveClientConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl ?? "https://api.pipedrive.com";
    this.dailyMutationLimit = config.dailyMutationLimit ?? 2500;
    this.limiter = new Bottleneck({
      maxConcurrent: config.maxConcurrent ?? 5,
      minTime: config.minTimeMs ?? 200
    });
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    return this.limiter.schedule(() => this.requestWithRetry<T>(method, path, options));
  }

  private async requestWithRetry<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    attempt = 1
  ): Promise<T> {
    this.enforceDailyMutationBudget(method, path);
    const maxAttempts = 5;
    const url = new URL(path, this.baseUrl);
    const query = { ...options.query, api_token: this.token };

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        const waitMs = 250 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.requestWithRetry(method, path, options, attempt + 1);
      }

      const responseText = await response.text();
      throw new Error(`Pipedrive request failed ${method} ${path} status=${response.status} body=${responseText}`);
    }

    const json = (await response.json()) as PipedriveEnvelope<T> | T;
    if (this.isEnvelope<T>(json)) {
      return json.data;
    }

    return json;
  }

  private isEnvelope<T>(value: unknown): value is PipedriveEnvelope<T> {
    return Boolean(value && typeof value === "object" && "data" in (value as Record<string, unknown>));
  }

  async paginateV2<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.rawEnvelope<T[]>("GET", path, {
        query: {
          ...query,
          cursor
        }
      });
      result.push(...(response.data ?? []));
      cursor = response.additional_data?.next_cursor ?? undefined;
    } while (cursor);

    return result;
  }

  private async rawEnvelope<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {}
  ): Promise<PipedriveEnvelope<T>> {
    return this.limiter.schedule(() => this.rawEnvelopeWithRetry(method, path, options));
  }

  private async rawEnvelopeWithRetry<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    attempt = 1
  ): Promise<PipedriveEnvelope<T>> {
    this.enforceDailyMutationBudget(method, path);
    const maxAttempts = 5;
    const url = new URL(path, this.baseUrl);
    const query = { ...options.query, api_token: this.token };

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        const waitMs = 250 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.rawEnvelopeWithRetry(method, path, options, attempt + 1);
      }
      const responseText = await response.text();
      throw new Error(`Pipedrive request failed ${method} ${path} status=${response.status} body=${responseText}`);
    }

    return (await response.json()) as PipedriveEnvelope<T>;
  }

  private async requestFirstSupported<T>(
    method: HttpMethod,
    paths: string[],
    options: RequestOptions = {}
  ): Promise<T> {
    for (const path of paths) {
      try {
        return await this.request<T>(method, path, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("status=404")) {
          throw error;
        }
      }
    }

    throw new Error(`No supported endpoint for ${method} among ${paths.join(", ")}`);
  }

  private enforceDailyMutationBudget(method: HttpMethod, path: string): void {
    if (method === "GET") {
      return;
    }

    const key = dayKey();
    const current = this.mutationUsage.get(key) ?? 0;
    if (current >= this.dailyMutationLimit) {
      throw new Error(
        `Daily mutation limit reached (${this.dailyMutationLimit}). Blocking ${method} ${path}`
      );
    }
    this.mutationUsage.set(key, current + 1);
  }

  leads = {
    list: async (query: Record<string, string | number | boolean | undefined> = {}) =>
      this.paginateV2<PipedriveLead>("/api/v2/leads", query),
    search: async (term: string) =>
      this.paginateV2<PipedriveLead>("/api/v2/leads/search", {
        term,
        exact_match: false
      }),
    get: async (id: string) => this.request<PipedriveLead>("GET", `/api/v2/leads/${id}`),
    update: async (id: string, body: Record<string, unknown>) =>
      this.request<PipedriveLead>("PATCH", `/api/v2/leads/${id}`, { body }),
    convertToDeal: async (id: string) => {
      const candidates = [`/api/v2/leads/${id}/convert`, `/api/v2/leads/${id}/convert/deal`];
      return this.requestFirstSupported<Record<string, unknown>>("POST", candidates);
    }
  };

  deals = {
    list: async (query: Record<string, string | number | boolean | undefined> = {}) =>
      this.paginateV2<PipedriveDeal>("/api/v2/deals", query),
    get: async (id: number) => this.request<PipedriveDeal>("GET", `/api/v2/deals/${id}`),
    update: async (id: number, body: Record<string, unknown>) =>
      this.request<PipedriveDeal>("PATCH", `/api/v2/deals/${id}`, { body })
  };

  activities = {
    list: async (query: Record<string, string | number | boolean | undefined> = {}) =>
      this.request<PipedriveActivity[]>("GET", "/v1/activities", { query }),
    create: async (body: Record<string, unknown>) =>
      this.request<PipedriveActivity>("POST", "/v1/activities", { body })
  };

  notes = {
    list: async (query: Record<string, string | number | boolean | undefined> = {}) =>
      this.request<PipedriveNote[]>("GET", "/v1/notes", { query }),
    create: async (body: Record<string, unknown>) =>
      this.request<PipedriveNote>("POST", "/v1/notes", { body })
  };

  persons = {
    search: async (term: string) =>
      this.request<PipedrivePerson[]>("GET", "/v1/persons/search", {
        query: { term, fields: "name,email" }
      }),
    get: async (id: number) => this.request<PipedrivePerson>("GET", `/v1/persons/${id}`),
    update: async (id: number, body: Record<string, unknown>) =>
      this.request<PipedrivePerson>("PUT", `/v1/persons/${id}`, { body }),
    merge: async (sourceId: number, targetId: number) =>
      this.requestFirstSupported<PipedrivePerson>(
        "POST",
        [`/v1/persons/${sourceId}/merge`, `/v1/persons/${sourceId}/merge/${targetId}`],
        { body: { merge_with_id: targetId } }
      )
  };

  orgs = {
    search: async (term: string) =>
      this.request<PipedriveOrg[]>("GET", "/v1/organizations/search", {
        query: { term, fields: "name" }
      }),
    get: async (id: number) => this.request<PipedriveOrg>("GET", `/v1/organizations/${id}`),
    update: async (id: number, body: Record<string, unknown>) =>
      this.request<PipedriveOrg>("PUT", `/v1/organizations/${id}`, { body }),
    merge: async (sourceId: number, targetId: number) =>
      this.requestFirstSupported<PipedriveOrg>(
        "POST",
        [`/v1/organizations/${sourceId}/merge`, `/v1/organizations/${sourceId}/merge/${targetId}`],
        { body: { merge_with_id: targetId } }
      )
  };

  webhooks = {
    list: async () => this.request<Record<string, unknown>[]>("GET", "/v1/webhooks"),
    create: async (body: Record<string, unknown>) =>
      this.request<Record<string, unknown>>("POST", "/v1/webhooks", { body }),
    delete: async (id: number) => this.request<Record<string, unknown>>("DELETE", `/v1/webhooks/${id}`)
  };

  fields = {
    list: async (entityType: FieldMapEntityType): Promise<PipedriveField[]> => {
      const v2Path = `/api/v2/${entityType}Fields`;
      try {
        return await this.paginateV2<PipedriveField>(v2Path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ entityType, message }, "Falling back to legacy field endpoint");
        const legacyPath =
          entityType === "org" ? "/v1/organizationFields" : `/v1/${entityType}Fields`;
        return this.request<PipedriveField[]>("GET", legacyPath);
      }
    }
  };

  buildRequestFingerprint(path: string, payload: unknown): string {
    return stableHash({ path, payload });
  }
}
