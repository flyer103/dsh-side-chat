# Real-DOM smoke

Loads the shipped `lib/client.js` into jsdom and mounts it with real React 18:
no GUI automation, no build step. It exercises the tab body and the selection
action with real hooks and DOM events, skipping capabilities the branch does not
ship.

```sh
cd tests/dom
npm install
npm test
# or point it at another bundle:
BUNDLE_PATH=../../lib/client.js npm test
```

Covered for this branch: the selection action and its companion segment (one
pill, opened tab, quoted draft + caret focus, cleanup on unmount). The script
also contains the checks used by later PRs (quote button, question card, lookup
toggle, turn process) and reports SKIP for the ones this branch does not render.
