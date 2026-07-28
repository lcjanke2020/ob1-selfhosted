// Shared error taxonomy for transport-independent services. Keeping these in a
// leaf module lets database scope resolution fail as a client validation error
// without importing the orchestration layer (and creating a dependency cycle).

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class UpstreamError extends Error {}
