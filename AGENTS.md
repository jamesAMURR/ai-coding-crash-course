# AGENTS.md

Cadence is a course platform (a mini Udemy) and the exercise repo for the AI Coding Crash Course. Scripts live in `package.json`; formatting in `.prettierrc`.

## Checks

- **Typecheck** with `npm run typecheck`, which runs `react-router typegen` before `tsc` to generate the `./+types/*` route modules. Bare `tsc` reports them missing.
- **Test** with `npm test` (Vitest).
- Prettier is the only style tool — there is no lint script.

## Architecture

Requests flow **route → service → Drizzle**:

- **Routes** (`app/routes/`) own HTTP concerns — loaders, actions, redirects, status codes — and rendering. Routing is config-based: a new page is a module in `app/routes/` **plus** an entry in `app/routes.ts`.
- **Services** (`app/services/`) own data access: plain synchronous functions with positional parameters, using the shared `db` from `~/db` directly rather than taking a handle.
- **`app/db/index.ts`** must stay side-effect free — its header comment explains why.

Every service and most `app/lib` modules open with a `// ─── Name ───` header recording the module's responsibility and the reasoning behind non-obvious decisions. Read it before changing the module.

## Access control

There is no password auth. The session holds a `userId` and a `devCountry` override, both set from the DevUI panel (`app/components/dev-ui.tsx`). A 401 reading "Select a user from the DevUI panel" means no user is selected.

Authorisation lives in `app/lib/access.server.ts`: `getAccess` (never throws) plus the `require*` guards. Loaders and actions are authorised independently — every mutating action calls a `require*` guard itself, whatever its loader does.

Purchasing-power-parity restrictions feed into `getAccess`; see `app/lib/ppp.ts` and `app/lib/country.server.ts`.

## Input validation

Route actions and loaders validate input with the Zod helpers in `app/lib/validation.ts`.

## Markdown

`renderComment` (`app/lib/comment-markdown.server.ts`) renders untrusted student input; `renderMarkdown` (`app/lib/markdown.server.ts`) renders trusted instructor content and passes raw HTML through. Both feed `dangerouslySetInnerHTML`, so changes to the comment renderer are security-sensitive — read its header first.

## Testing

Tests run against an in-memory database from `createTestDb` in `app/test/setup.ts`. Copy the `vi.mock("~/db", ...)` preamble from an existing service test such as `app/services/courseService.test.ts`, keeping the import of the module under test **below** the mock — above it, the service silently binds to the real `data.db`.

## Conventions

- Enums are TypeScript `enum`s exported from `app/db/schema.ts`, used at every insert site.
- Server-only modules take the `.server.ts` suffix.

## Course checkpoints

`main` is the student starting point; lesson checkpoints are commits on the `live-run-through` branch, each message prefixed with a slug. Students navigate by slug through `npm run reset`, `cherry-pick`, and `pull`, and recorded video cites them — so slugs are a public interface and existing ones never change.
