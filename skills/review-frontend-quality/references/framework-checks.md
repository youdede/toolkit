# Framework routing checks

Use these as investigation routes, not timeless rules. Inspect the installed version and its local or official documentation before making version-sensitive claims.

## React

Trace render ownership, stable identity, effects with external synchronization, controlled inputs, suspense/error boundaries, and state colocated at the narrowest useful owner.

## Next.js

Identify router and rendering boundary first. Check server/client ownership, serialization boundaries, caching and revalidation intent, route loading/error/not-found states, metadata, image/font handling, and hydration consistency.

## Vue and Nuxt

Check reactive ownership, computed versus watched state, keyed lists, lifecycle cleanup, server/client boundaries, route data states, and hydration consistency.

## Svelte and SvelteKit

Check reactive dependencies, store ownership, cleanup, load/action error paths, progressive enhancement, server-only data, and hydration consistency.

## Angular

Check template semantics, change-detection cost, observable cleanup, dependency scope, router states, form accessibility, and consistent design-system primitives.

