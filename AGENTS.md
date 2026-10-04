# Working on Pi Pocket

Pi Pocket is often edited from inside itself, while it runs. Keep that safe:

- `web/**` changes reload every open browser right away. Keep the app loadable after each save: a syntax error blanks the screen for everyone, including you. Check with `node --check web/<file>.js` after editing.
- `src/server/extensions/*.ts` changes are reinstalled into the running server. A file that fails to load keeps its previous version and reports the error. Each module default-exports `(host) => Extension | Extension[]`. Start each module with a `/** … */` comment: its first sentence is the description in the app's Extensions sheet, where the owner can turn modules off (a module that is off is not loaded, even when edited).
- Other `src/server/**` changes need a restart (menu → Restart server). Running work resumes after it, but a tool call cut off mid-run that is not replay-safe comes back as interrupted. Do not restart while your own tool call is running; finish the edit, run `npm run check`, then ask the user to restart.
- Document kinds in `src/server/docs.ts` are stored data. Do not rename them.
- The server is plain TypeScript run by Node's type stripping: only erasable syntax (no enums, no parameter properties, no namespaces). Imports use `.ts` extensions.
- Run `npm run check` and `npm test` after server changes.
