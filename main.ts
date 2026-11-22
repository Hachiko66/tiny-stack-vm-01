// Tiny stack VM — a complete interpreter for make.fun's tiny stack ISA v1.
// Every program is one bytecode file; this VM runs it and writes exactly
// what it wrote plus the code it ended with. All 32-bit arithmetic wraps,
// every trap keeps the output written before it, and the limits are exact:
// 256 data values, 64 return addresses, 256 memory words, 1,000,000 steps,
// 65,536 output bytes. No clock, no network, no randomness: the same input
// always gives the same bytes back, so two runs match byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Run one program on its input bytes. Returns the bytes it wrote and the
// code it ended with: 0 for HALT, the EXIT value, or a trap code 2..11.
function execute(prog: Uint8Array, inp: Uint8Array): { bytes: Uint8Array; code: number } {
  const stack = new Int32Array(256);
  let sp = 0;
  const calls = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out: number[] = [];
  let ip = 0;
  let pc = 0;
  let done = 0;
  const finish = (code: number): { bytes: Uint8Array; code: number } => ({ bytes: Uint8Array.from(out), code });
  while (true) {
    if (done === 1000000) return finish(10);
    if (pc < 0 || pc >= prog.length) return finish(9);
    const byte = prog[pc];
    // How many stack values each opcode takes and leaves, and how long its
    // immediate is. Unknown bytes trap 5 before anything else happens.
    let need = 0;
    let give = 0;
    let imm = 0;
    switch (byte) {
      case 0x01: imm = 1; give = 1; break;
      case 0x02: imm = 4; give = 1; break;
      case 0x04: case 0x17: case 0x1b: need = 1; give = 1; break;
      case 0x03: case 0x40: case 0x50: case 0x51: case 0x53: need = 1; break;
      case 0x05: case 0x06: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x20: case 0x21: case 0x22: need = 2; give = 1; break;
      case 0x07: need = 3; give = 3; break;
      case 0x31: case 0x32: imm = 2; need = 1; break;
      case 0x30: case 0x33: imm = 2; break;
      case 0x41: need = 2; break;
      case 0x52: give = 1; break;
      case 0x00: case 0x34: break;
      default: return finish(5);
    }
    if (pc + imm >= prog.length && imm > 0) return finish(9);
    done++;
    const after = pc + 1 + imm;
    if (sp < need) return finish(2);
    if (sp - need + give > 256) return finish(3);
    pc = after;
    if (byte === 0x00) return finish(0);
    if (byte === 0x01) { stack[sp++] = (prog[after - 1] << 24) >> 24; continue; }
    if (byte === 0x02) { stack[sp++] = prog[after - 4] | (prog[after - 3] << 8) | (prog[after - 2] << 16) | (prog[after - 1] << 24); continue; }
    if (byte === 0x03) { sp--; continue; }
    if (byte === 0x04) { stack[sp] = stack[sp - 1]; sp++; continue; }
    if (byte === 0x05) { const t = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t; continue; }
    if (byte === 0x06) { stack[sp] = stack[sp - 2]; sp++; continue; }
    if (byte === 0x07) { const a = stack[sp - 3]; stack[sp - 3] = stack[sp - 2]; stack[sp - 2] = stack[sp - 1]; stack[sp - 1] = a; continue; }
    if (byte === 0x17) { stack[sp - 1] = -stack[sp - 1] | 0; continue; }
    if (byte === 0x1b) { stack[sp - 1] = ~stack[sp - 1]; continue; }
    if (byte === 0x52) { stack[sp++] = ip < inp.length ? inp[ip++] : -1; continue; }
    if (byte === 0x30 || byte === 0x31 || byte === 0x32) {
      const off = ((prog[after - 2] | (prog[after - 1] << 8)) << 16) >> 16;
      let go = true;
      if (byte !== 0x30) { const v = stack[--sp]; go = byte === 0x31 ? v === 0 : v !== 0; }
      if (go) pc = after + off;
      continue;
    }
    if (byte === 0x33) {
      if (cp === 64) return finish(7);
      calls[cp++] = after;
      pc = prog[after - 2] | (prog[after - 1] << 8);
      continue;
    }
    if (byte === 0x34) {
      if (cp === 0) return finish(8);
      pc = calls[--cp];
      continue;
    }
    if (byte === 0x40) {
      const addr = stack[sp - 1];
      if (addr < 0 || addr >= 256) return finish(6);
      stack[sp - 1] = mem[addr];
      continue;
    }
    if (byte === 0x41) {
      const addr = stack[sp - 1];
      const val = stack[sp - 2];
      if (addr < 0 || addr >= 256) return finish(6);
      sp -= 2;
      mem[addr] = val;
      continue;
    }
    if (byte === 0x50) {
      const txt = String(stack[sp - 1]);
      if (out.length + txt.length > 65536) return finish(11);
      sp--;
      for (let i = 0; i < txt.length; i++) out.push(txt.charCodeAt(i));
      continue;
    }
    if (byte === 0x51) {
      if (out.length + 1 > 65536) return finish(11);
      out.push(stack[--sp] & 255);
      continue;
    }
    if (byte === 0x53) return finish(stack[--sp] & 255);
    // Two-operand arithmetic and comparison. b is the top, a is below it.
    const b = stack[sp - 1];
    const a = stack[sp - 2];
    let r = 0;
    if (byte === 0x10) r = (a + b) | 0;
    else if (byte === 0x11) r = (a - b) | 0;
    else if (byte === 0x12) r = Math.imul(a, b);
    else if (byte === 0x13) {
      if (b === 0) return finish(4);
      r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
    } else if (byte === 0x14) {
      if (b === 0) return finish(4);
      r = b === -1 ? 0 : (a % b) | 0;
    } else if (byte === 0x15) {
      if (b === 0) return finish(4);
      r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
    } else if (byte === 0x16) {
      if (b === 0) return finish(4);
      r = ((a >>> 0) % (b >>> 0)) | 0;
    } else if (byte === 0x18) r = a & b;
    else if (byte === 0x19) r = a | b;
    else if (byte === 0x1a) r = a ^ b;
    else if (byte === 0x1c) r = a << (b & 31);
    else if (byte === 0x1d) r = a >> (b & 31);
    else if (byte === 0x1e) r = (a >>> (b & 31)) | 0;
    else if (byte === 0x20) r = a === b ? 1 : 0;
    else if (byte === 0x21) r = a < b ? 1 : 0;
    else if (byte === 0x22) r = (a >>> 0) < (b >>> 0) ? 1 : 0;
    sp -= 2;
    stack[sp++] = r;
  }
}

for (const id of readdirSync(IN_DIR).sort()) {
  const prog = new Uint8Array(readFileSync(join(IN_DIR, id, 'program.bin')));
  const inp = new Uint8Array(readFileSync(join(IN_DIR, id, 'input.bin')));
  const ans = execute(prog, inp);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), ans.bytes);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), `${ans.code}\n`);
}
