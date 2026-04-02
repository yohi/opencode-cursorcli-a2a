// src/server/a2a-types.ts
// A2A Protocol v1.0.0 データモデル型定義
import { z } from 'zod';

// --- A2A Part (§4.1.6) ---
export const A2APartSchema = z.object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
}).refine(
    (p) => p.text !== undefined || p.raw !== undefined || p.url !== undefined,
    { message: 'Part must have at least one of: text, raw, url' },
);
export type A2APart = z.infer<typeof A2APartSchema>;

// --- A2A Message (§4.1.4) ---
export const A2AMessageSchema = z.object({
    role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
    parts: z.array(A2APartSchema).min(1),
    messageId: z.string().optional(),
    extensions: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// --- A2A SendMessageRequest (§3.2.1) ---
export const A2ASendMessageRequestSchema = z.object({
    message: A2AMessageSchema,
    configuration: z.object({
        acceptedOutputModes: z.array(z.string()).optional(),
        blocking: z.boolean().optional(),
    }).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2ASendMessageRequest = z.infer<typeof A2ASendMessageRequestSchema>;

// --- A2A TaskStatus (§4.1.3) ---
export const A2A_TASK_STATES = [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_REJECTED',
] as const;

export const A2ATaskStatusSchema = z.object({
    state: z.enum(A2A_TASK_STATES),
    message: A2AMessageSchema.optional(),
    timestamp: z.string().optional(),
});
export type A2ATaskStatus = z.infer<typeof A2ATaskStatusSchema>;

// --- A2A Artifact (§4.1.7) ---
export const A2AArtifactSchema = z.object({
    artifactId: z.string(),
    name: z.string().optional(),
    parts: z.array(A2APartSchema),
    append: z.boolean().optional(),
    lastChunk: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2AArtifact = z.infer<typeof A2AArtifactSchema>;

// --- A2A Task (§4.1.1) ---
export const A2ATaskSchema = z.object({
    id: z.string(),
    contextId: z.string(),
    status: A2ATaskStatusSchema,
    artifacts: z.array(A2AArtifactSchema).optional(),
    history: z.array(A2AMessageSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2ATask = z.infer<typeof A2ATaskSchema>;

// --- A2A Streaming Events (§4.2) ---
export const A2ATaskStatusUpdateEventSchema = z.object({
    taskId: z.string(),
    contextId: z.string().optional(),
    status: A2ATaskStatusSchema,
    final: z.boolean().optional(),
});

export const A2AArtifactUpdateEventSchema = z.object({
    taskId: z.string(),
    contextId: z.string().optional(),
    artifact: A2AArtifactSchema,
});

// --- A2A StreamResponse (§3.2.3) ---
export const A2AStreamResponseSchema = z.union([
    z.object({ task: A2ATaskSchema }),
    z.object({ message: A2AMessageSchema }),
    z.object({ statusUpdate: A2ATaskStatusUpdateEventSchema }),
    z.object({ artifactUpdate: A2AArtifactUpdateEventSchema }),
]);
export type A2AStreamResponse = z.infer<typeof A2AStreamResponseSchema>;

// --- A2A Agent Card (§4.4.1) ---
export const A2AAgentCardSchema = z.object({
    name: z.string(),
    description: z.string(),
    version: z.string().optional(),
    supportedInterfaces: z.array(z.object({
        url: z.string(),
        protocolBinding: z.string(),
        protocolVersion: z.string(),
    })),
    capabilities: z.object({
        streaming: z.boolean().optional(),
        pushNotifications: z.boolean().optional(),
        stateTransitionHistory: z.boolean().optional(),
        extendedAgentCard: z.boolean().optional(),
    }),
    securitySchemes: z.record(z.unknown()).optional(),
    security: z.array(z.record(z.array(z.string()))).optional(),
    defaultInputModes: z.array(z.string()),
    defaultOutputModes: z.array(z.string()),
    skills: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
    })),
});
export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;
