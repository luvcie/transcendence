const children = [
  Bun.spawn(["bun", "run", "--cwd", "packages/server", "dev"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "run", "--cwd", "packages/web", "dev"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
];
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => children.forEach(child => child.kill(signal)));
const exitCode = await Promise.race(children.map(child => child.exited));
for (const child of children) child.kill();
await Promise.all(children.map(child => child.exited));
process.exit(exitCode);
