import type { Role } from "./protocol.ts";

export type Capability = "view" | "chat" | "prompt";

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
	viewer: ["view"],
	contributor: ["view", "chat", "prompt"],
};

export const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];

export function isRole(value: string): value is Role {
	return (ROLES as string[]).includes(value);
}

export function can(role: Role, capability: Capability): boolean {
	return ROLE_CAPABILITIES[role].includes(capability);
}
