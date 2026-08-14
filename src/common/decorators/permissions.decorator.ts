import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Marks a route as requiring one or more permissions (see Module 1
 * design doc, section 10 — Permissions). Policy-based, not role-based:
 * the guard checks the actor's granted permission strings, so an
 * organization can compose its own roles out of these primitives
 * without code changes.
 *
 * Example: @RequirePermissions('customer.write')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
