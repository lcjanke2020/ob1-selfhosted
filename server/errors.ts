// Shared error taxonomy for transport-independent services. Keeping these in a
// leaf module lets database scope resolution fail as a client validation error
// without importing the orchestration layer (and creating a dependency cycle).

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class UpstreamError extends Error {}
// A mutation that would collide with existing state the caller can already
// see (for example, identical thought content already present in the target
// audience). REST maps it to 409; MCP surfaces the message as a tool error.
export class ConflictError extends Error {}
