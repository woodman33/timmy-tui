// R10 (H163; the turn-holds latency): src/cli.ts's first import. React's production build is loaded here, before anything can
// load React, and NODE_ENV is left as it was (src/react-build.ts); TIMMY_REACT_DEV=1 keeps the development build.
import { loadReactProduction } from './react-build.js';

loadReactProduction();
