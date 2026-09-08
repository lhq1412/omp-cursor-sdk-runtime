#!/usr/bin/env bun
console.log(`Stock OMP 18.1.14 does not pass ompCursorRuntimeHost on stream options.
This adapter uses context.tools + park-and-yield so brew omp can still run
read/edit/bash through OMP's own tool loop (approval included).

Optional host-bridge patch notes: integration/omp/HOST_BRIDGE.md`);
