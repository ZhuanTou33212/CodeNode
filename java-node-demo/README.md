# CodeNode Java demo

This is the first-stage Java node example: left and right inputs connect to AddIntegers and produce result.

The canvas-ready node contract is stored at `src/main/resources/codenode/nodes/add-integers.json`.

Run in an environment with Maven installed:

    mvn test

The plugin does not embed Maven Wrapper binaries. In a real project, commit an audited mvnw, .mvn/wrapper, and pinned Maven version.
