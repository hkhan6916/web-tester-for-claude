/* eslint-disable no-console */

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

export const log = {
  info: (msg: string): void => console.log(msg),
  dim: (msg: string): void =>
    console.log(`${COLORS.dim}${msg}${COLORS.reset}`),
  ok: (msg: string): void =>
    console.log(`${COLORS.green}${msg}${COLORS.reset}`),
  warn: (msg: string): void =>
    console.log(`${COLORS.yellow}${msg}${COLORS.reset}`),
  fail: (msg: string): void => console.log(`${COLORS.red}${msg}${COLORS.reset}`),
  step: (msg: string): void => console.log(`${COLORS.cyan}${msg}${COLORS.reset}`),
  header: (msg: string): void =>
    console.log(`${COLORS.blue}\n=== ${msg} ===${COLORS.reset}`),
  raw: (msg: string): void => console.log(msg)
};
