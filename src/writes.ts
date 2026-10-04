/**
 * Password-gated write tools.
 *
 * These are registered only when KEAP_WRITE_PASSWORD is set; without it the
 * server stays strictly read-only. Every call that changes data must carry the
 * password, checked in constant time. Repeated wrong passwords lock writes for
 * everyone for a while, which matters in hosted mode where many clients share
 * one process.
 *
 * The password is a per-call argument rather than a session unlock because the
 * HTTP transport is stateless: there is no session to remember an unlock in.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "./config.js";
import { KeapClient, KeapError, resolvePath, stripPathParams } from "./client.js";
import {
  resolveWriteEndpoint,
  searchWriteEndpoints,
  summariseWriteEndpoint,
  writeEndpoints,
  type WriteEndpoint,
} from "./catalog.js";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

/**
 * Process-wide so it survives across HTTP requests, where a fresh McpServer is
 * built per call.
 */
const guardState = { failures: [] as number[], lockedUntil: 0 };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Returns an error message, or undefined when the password is accepted. */
export function checkPassword(config: Config, presented: string | undefined): string | undefined {
  const now = Date.now();
  if (guardState.lockedUntil > now) {
    const minutes = Math.ceil((guardState.lockedUntil - now) / 60_000);
    return `Writes are locked for ${minutes} more minute(s) after repeated wrong passwords.`;
  }
  if (!presented) {
    return "This tool changes data in Keap and needs the write password. Ask the user for it; do not guess.";
  }
  // Hashing first makes the comparison length-independent.
  if (timingSafeEqual(digest(presented), digest(config.writePassword))) {
    guardState.failures = [];
    return undefined;
  }
  guardState.failures = guardState.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  guardState.failures.push(now);
  console.error(`keapmcp: rejected write password (${guardState.failures.length}/${MAX_FAILURES})`);
  if (guardState.failures.length >= MAX_FAILURES) {
    guardState.lockedUntil = now + LOCKOUT_MS;
    guardState.failures = [];
    return `Wrong write password. Writes are now locked for ${LOCKOUT_MS / 60_000} minutes.`;
  }
  return "Wrong write password. Ask the user to check it; do not guess.";
}

/** Test hook: clear lockout state between runs. */
export function resetPasswordGuard(): void {
  guardState.failures = [];
  guardState.lockedUntil = 0;
}

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function failure(error: unknown) {
  const message =
    error instanceof KeapError ? error.message : error instanceof Error ? error.message : String(error);
  return { ...text(`Error: ${message}`), isError: true as const };
}

const password = z
  .string()
  .describe(
    "The write password, exactly as the user gave it. Required for every change. Never guess it or reuse " +
      "one from another system; if you do not have it, ask the user.",
  )
  // Optional in the schema so a missing password reaches checkPassword and gets
  // a clear "ask the user" message instead of a generic validation error.
  .optional();

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

type Scalar = string | number | boolean;

function prune<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

/** Resolve, validate and send one write call. Shared by every tool. */
async function execute(
  client: KeapClient,
  endpoint: WriteEndpoint,
  params: Record<string, Scalar | Scalar[]>,
  body: unknown,
): Promise<unknown> {
  const path = resolvePath(endpoint, params);
  const query = stripPathParams(endpoint, params);
  const url = client.buildUrl(path, query);
  console.error(`keapmcp: write ${endpoint.method} ${path}`);
  return client.send(endpoint.method, url, body);
}

function mustResolve(id: string): WriteEndpoint {
  const endpoint = resolveWriteEndpoint(id);
  if (!endpoint) throw new Error(`Write endpoint ${id} is missing from the catalog. Rebuild with npm run build.`);
  return endpoint;
}

export const WRITE_INSTRUCTIONS =
  "\n\nWrite access is enabled but password-protected. Tools that change data (keap_create_contact, " +
  "keap_update_contact, keap_create_tag, keap_create_tag_category, keap_tag_contacts, keap_create_note, " +
  "keap_create_task, keap_create_company, keap_write) need the write password in their `password` argument. " +
  "Only use a password the user has given you in this conversation; never guess one. Before creating " +
  "anything, check it does not already exist with the read tools. For anything without a dedicated tool, " +
  "find the endpoint with keap_find_write_endpoints and call keap_write.";

export function registerWriteTools(server: McpServer, client: KeapClient, config: Config): void {
  const guarded =
    <A extends { password?: string }>(run: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      const problem = checkPassword(config, args.password);
      if (problem) return failure(problem);
      try {
        return text(await run(args));
      } catch (error) {
        return failure(error);
      }
    };

  server.registerTool(
    "keap_create_contact",
    {
      title: "Create a Keap contact",
      description:
        "Create a contact, optionally applying tags afterwards. Search for an existing contact by email " +
        "first to avoid duplicates, or set duplicate_option so Keap updates a match instead. Needs the write password.",
      inputSchema: {
        password,
        given_name: z.string().optional().describe("First name"),
        family_name: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Primary email address"),
        phone: z.string().optional().describe("Primary phone number"),
        job_title: z.string().optional(),
        owner_id: z.string().optional().describe("Keap user id that owns the contact"),
        tag_ids: z.array(z.string()).optional().describe("Tags to apply after the contact is created"),
        duplicate_option: z
          .enum(["Email", "EmailAndName", "EmailAndNameAndCompany"])
          .optional()
          .describe("If set, Keap updates a matching existing contact instead of creating a duplicate"),
        extra: z
          .record(z.unknown())
          .optional()
          .describe(
            "Any other v2 contact fields, merged into the request body, e.g. {addresses:[...], website:'...'}. " +
              "See keap_find_write_endpoints endpoint='v2.createContact' for the full shape.",
          ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const body: Record<string, unknown> = {
        ...prune({
          given_name: args.given_name,
          family_name: args.family_name,
          job_title: args.job_title,
          owner_id: args.owner_id,
        }),
        ...(args.email ? { email_addresses: [{ email: args.email, field: "EMAIL1" }] } : {}),
        ...(args.phone ? { phone_numbers: [{ number: args.phone, field: "PHONE1" }] } : {}),
        ...(args.extra ?? {}),
      };
      if (!Object.keys(body).length) throw new Error("Give at least a name, email or phone for the contact.");

      const params = prune({ duplicate_option: args.duplicate_option }) as Record<string, Scalar>;
      const contact = (await execute(client, mustResolve("v2.createContact"), params, body)) as Record<string, unknown>;
      const tagged = await applyTags(client, args.tag_ids, contact?.id);
      return { created: contact, tags_applied: tagged };
    }),
  );

  server.registerTool(
    "keap_update_contact",
    {
      title: "Update a Keap contact",
      description:
        "Change fields on an existing contact. Only the fields you pass are touched. List fields such as " +
        "email_addresses or phone_numbers replace the whole list, so read the contact first and send the full " +
        "list you want. Needs the write password.",
      inputSchema: {
        password,
        contact_id: z.union([z.string(), z.number()]).describe("Contact id"),
        fields: z
          .record(z.unknown())
          .describe("v2 contact fields to set, e.g. {given_name:'Sam', job_title:'CEO'}"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const keys = Object.keys(args.fields);
      if (!keys.length) throw new Error("Pass at least one field to update.");
      return execute(
        client,
        mustResolve("v2.updateContact"),
        { contact_id: String(args.contact_id), update_mask: keys.join(",") },
        args.fields,
      );
    }),
  );

  server.registerTool(
    "keap_create_tag",
    {
      title: "Create a Keap tag",
      description:
        "Create a tag, optionally inside a tag category. Check the tag does not already exist first " +
        "(keap_get v2.listTags). Needs the write password.",
      inputSchema: {
        password,
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        category_id: z.union([z.string(), z.number()]).optional().describe("Tag category id to file it under"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) =>
      execute(client, mustResolve("v2.createTag"), {}, {
        name: args.name,
        ...prune({ description: args.description }),
        ...(args.category_id !== undefined ? { category: { id: String(args.category_id) } } : {}),
      }),
    ),
  );

  server.registerTool(
    "keap_create_tag_category",
    {
      title: "Create a Keap tag category",
      description:
        "Create a tag category: the group that tags are organised under in Keap. Needs the write password.",
      inputSchema: {
        password,
        name: z.string().min(1),
        description: z.string().optional(),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) =>
      execute(client, mustResolve("v2.createTagCategory"), {}, {
        name: args.name,
        ...prune({ description: args.description }),
      }),
    ),
  );

  server.registerTool(
    "keap_tag_contacts",
    {
      title: "Apply or remove Keap tags",
      description:
        "Apply tags to, or remove tags from, one or more contacts. Applying a tag can trigger Keap " +
        "automations such as emails or campaign sequences. Needs the write password.",
      inputSchema: {
        password,
        action: z.enum(["apply", "remove"]),
        tag_ids: z.array(z.union([z.string(), z.number()])).min(1).max(50),
        contact_ids: z.array(z.union([z.string(), z.number()])).min(1).max(1000),
      },
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
    },
    guarded(async (args) => {
      const endpoint = mustResolve(args.action === "apply" ? "v2.applyTags" : "v2.removeTags");
      const contact_ids = [...new Set(args.contact_ids.map(String))];
      const results: Record<string, unknown> = {};
      for (const tag of args.tag_ids) {
        try {
          results[String(tag)] = await execute(client, endpoint, { tag_id: String(tag) }, { contact_ids });
        } catch (error) {
          results[String(tag)] = { error: (error as Error).message };
        }
      }
      return { action: args.action, contacts: contact_ids.length, results };
    }),
  );

  server.registerTool(
    "keap_create_note",
    {
      title: "Add a note to a Keap contact",
      description:
        "Add a note to a contact's record. Keap requires the id of the user writing the note; find it with " +
        "keap_get v2.listUsers if the user has not said. Needs the write password.",
      inputSchema: {
        password,
        contact_id: z.union([z.string(), z.number()]),
        user_id: z.union([z.string(), z.number()]).describe("Keap user id the note is attributed to"),
        title: z.string().optional(),
        text: z.string().describe("Note body"),
        type: z.string().optional().describe("Note type, e.g. 'Call', 'Email', 'Other'"),
        is_pinned: z.boolean().optional(),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) =>
      execute(client, mustResolve("v2.createNote"), { contact_id: String(args.contact_id) }, {
        user_id: String(args.user_id),
        text: args.text,
        ...prune({ title: args.title, type: args.type, is_pinned: args.is_pinned }),
      }),
    ),
  );

  server.registerTool(
    "keap_create_task",
    {
      title: "Create a Keap task",
      description:
        "Create a task assigned to a Keap user, optionally linked to a contact. Needs the write password.",
      inputSchema: {
        password,
        title: z.string(),
        assigned_to_user_id: z.union([z.string(), z.number()]).describe("Keap user id the task is assigned to"),
        contact_id: z.union([z.string(), z.number()]).optional(),
        description: z.string().optional(),
        due_time: z.string().optional().describe("ISO date-time, e.g. '2026-10-12T09:00:00Z'"),
        priority: z.enum(["CRITICAL", "ESSENTIAL", "NONESSENTIAL"]).optional(),
        type: z.string().optional().describe("Task type, e.g. 'Call', 'Email', 'Other'"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) =>
      execute(client, mustResolve("v2.createTask"), {}, {
        title: args.title,
        assigned_to_user_id: String(args.assigned_to_user_id),
        ...prune({
          contact_id: args.contact_id !== undefined ? String(args.contact_id) : undefined,
          description: args.description,
          due_time: args.due_time,
          priority: args.priority,
          type: args.type,
        }),
      }),
    ),
  );

  server.registerTool(
    "keap_create_company",
    {
      title: "Create a Keap company",
      description: "Create a company record. Check it does not already exist first. Needs the write password.",
      inputSchema: {
        password,
        company_name: z.string(),
        website: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        extra: z
          .record(z.unknown())
          .optional()
          .describe("Any other v2 company fields, merged into the request body (e.g. address, notes)"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) =>
      execute(client, mustResolve("v2.createCompany"), {}, {
        company_name: args.company_name,
        ...prune({ website: args.website }),
        ...(args.email ? { email_address: { email: args.email, field: "EMAIL1" } } : {}),
        ...(args.phone ? { phone_number: { number: args.phone, field: "PHONE1" } } : {}),
        ...(args.extra ?? {}),
      }),
    ),
  );

  server.registerTool(
    "keap_find_write_endpoints",
    {
      title: "Search Keap write endpoints",
      description:
        `Search the ${writeEndpoints.length} write endpoints (POST/PUT/PATCH/DELETE) of the Keap API, or pass ` +
        "`endpoint` to see one endpoint's parameters and request body shape. Use this before keap_write. " +
        "Read-only: needs no password." +
        (config.allowDelete ? "" : " DELETE endpoints are listed but disabled on this server."),
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'opportunity', 'custom field', 'sequence'"),
        endpoint: z.string().optional().describe("A write endpoint id to describe in full, e.g. 'v2.updateTag'"),
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).optional(),
        version: z.enum(["v1", "v2"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Max results, default 40"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, endpoint: reference, method, version, limit }) => {
      try {
        if (reference) {
          const endpoint = resolveWriteEndpoint(reference);
          if (!endpoint) {
            const guesses = searchWriteEndpoints({ query: reference, limit: 8 }).map((e) => e.id);
            return failure(
              `Unknown write endpoint "${reference}".` + (guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : ""),
            );
          }
          return text({
            ...endpoint,
            enabled: endpoint.method !== "DELETE" || config.allowDelete,
            params: endpoint.params.map((p) => ({
              name: p.name,
              in: p.in,
              type: p.enum ? `enum(${p.enum.join("|")})` : p.type,
              required: p.required || undefined,
              description: p.description,
            })),
          });
        }
        const matches = searchWriteEndpoints({ query, method, version, limit });
        return text({ matched: matches.length, endpoints: matches.map(summariseWriteEndpoint) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "keap_write",
    {
      title: "Call any Keap write endpoint",
      description:
        "Call any Keap POST/PUT/PATCH" +
        (config.allowDelete ? "/DELETE" : "") +
        " endpoint, for changes the dedicated tools do not cover. Look up the endpoint and its body shape with " +
        "keap_find_write_endpoints first. Set dry_run to preview the exact request without sending it " +
        "(no password needed for a dry run). Needs the write password.",
      inputSchema: {
        password,
        endpoint: z.string().describe("Write endpoint id, e.g. 'v2.updateTag' or 'v2.createOpportunityStage'"),
        params: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("Path and query parameters, e.g. {tag_id: '123'}"),
        body: z.unknown().optional().describe("JSON request body"),
        dry_run: z.boolean().optional().describe("Return the request that would be sent, without sending it"),
      },
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
    },
    async (args) => {
      try {
        const endpoint = resolveWriteEndpoint(args.endpoint);
        if (!endpoint) {
          const guesses = searchWriteEndpoints({ query: args.endpoint, limit: 8 }).map((e) => e.id);
          return failure(
            `Unknown write endpoint "${args.endpoint}".` +
              (guesses.length ? ` Did you mean: ${guesses.join(", ")}?` : " Use keap_find_write_endpoints."),
          );
        }
        if (endpoint.method === "DELETE" && !config.allowDelete) {
          return failure(
            `${endpoint.id} is a DELETE endpoint, and deletes are disabled on this server. ` +
              "An administrator can enable them with KEAP_WRITE_ALLOW_DELETE=true.",
          );
        }
        const params = (args.params ?? {}) as Record<string, Scalar | Scalar[]>;
        const known = new Set(endpoint.params.map((p) => p.name));
        const unknown = Object.keys(params).filter((name) => !known.has(name));
        if (unknown.length) {
          return failure(
            `Unknown parameter(s) for ${endpoint.id}: ${unknown.join(", ")}. ` +
              `Accepted: ${[...known].join(", ") || "(none)"}. Request body fields go in \`body\`.`,
          );
        }
        if (endpoint.bodyRequired && args.body === undefined) {
          return failure(`${endpoint.id} needs a request body. See keap_find_write_endpoints for its shape.`);
        }

        if (args.dry_run) {
          const path = resolvePath(endpoint, params);
          return text({
            dry_run: true,
            method: endpoint.method,
            url: client.buildUrl(path, stripPathParams(endpoint, params)),
            body: args.body,
          });
        }

        const problem = checkPassword(config, args.password);
        if (problem) return failure(problem);

        const result = await execute(client, endpoint, params, args.body);
        return text({ endpoint: endpoint.id, method: endpoint.method, result });
      } catch (error) {
        return failure(error);
      }
    },
  );
}

async function applyTags(client: KeapClient, tagIds: string[] | undefined, contactId: unknown) {
  if (!tagIds?.length) return undefined;
  if (contactId === undefined || contactId === null) return { error: "Contact id missing from response; tags not applied." };
  const endpoint = mustResolve("v2.applyTags");
  const results: Record<string, unknown> = {};
  for (const tag of tagIds) {
    try {
      await execute(client, endpoint, { tag_id: tag }, { contact_ids: [String(contactId)] });
      results[tag] = "applied";
    } catch (error) {
      results[tag] = { error: (error as Error).message };
    }
  }
  return results;
}
