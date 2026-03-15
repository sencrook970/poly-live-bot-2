// ---------------------------------------------------------------------------
// Simple color-coded logger. No dependencies needed.
// ---------------------------------------------------------------------------

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

export const log = {
  info: (msg: string, ...args: unknown[]) => {
    console.log(`${COLORS.gray}[${timestamp()}]${COLORS.reset} ${msg}`, ...args);
  },

  success: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.green} ${msg}${COLORS.reset}`,
      ...args
    );
  },

  warn: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.yellow} ${msg}${COLORS.reset}`,
      ...args
    );
  },

  error: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.red} ${msg}${COLORS.reset}`,
      ...args
    );
  },

  trade: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.cyan} [TRADE] ${msg}${COLORS.reset}`,
      ...args
    );
  },

  opportunity: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.magenta} [OPPORTUNITY] ${msg}${COLORS.reset}`,
      ...args
    );
  },

  paper: (msg: string, ...args: unknown[]) => {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.blue} [PAPER] ${msg}${COLORS.reset}`,
      ...args
    );
  },
};
