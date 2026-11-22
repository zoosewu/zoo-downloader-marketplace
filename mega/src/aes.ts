// AES-128 decryption (FIPS-197), for the little MEGA keeps encrypted besides the file itself:
// file names and the keys of a folder's files. The host's crypto.subtle only hashes; the file's
// own bytes are decrypted by the app (`decrypt` in the result).

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  // p walks the multiplicative group by ×3, q by ÷3: q is p's inverse (Wikipedia, "Rijndael S-box").
  const rotl = (x: number, s: number) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}

/** Multiplication in GF(2^8). */
function mul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
    b >>= 1;
  }
  return r;
}

/** The 11 round keys of a 16-byte key, 16 bytes each. */
function expand(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 16 === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
      rcon = mul(rcon, 2);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}

/** Decrypts one 16-byte block (state bytes in column order, as FIPS-197 lays them out). */
function decryptBlock(rounds: Uint8Array, block: Uint8Array): Uint8Array {
  const s = new Uint8Array(block);
  const addRoundKey = (round: number) => {
    for (let i = 0; i < 16; i++) s[i] ^= rounds[round * 16 + i];
  };
  const invShiftAndSub = () => {
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[((c + r) % 4) * 4 + r] = INV_SBOX[t[c * 4 + r]];
  };
  addRoundKey(10);
  for (let round = 9; round >= 1; round--) {
    invShiftAndSub();
    addRoundKey(round);
    for (let c = 0; c < 4; c++) {
      const [a, b, d, e] = s.subarray(c * 4, c * 4 + 4);
      s[c * 4] = mul(a, 14) ^ mul(b, 11) ^ mul(d, 13) ^ mul(e, 9);
      s[c * 4 + 1] = mul(a, 9) ^ mul(b, 14) ^ mul(d, 11) ^ mul(e, 13);
      s[c * 4 + 2] = mul(a, 13) ^ mul(b, 9) ^ mul(d, 14) ^ mul(e, 11);
      s[c * 4 + 3] = mul(a, 11) ^ mul(b, 13) ^ mul(d, 9) ^ mul(e, 14);
    }
  }
  invShiftAndSub();
  addRoundKey(0);
  return s;
}

/** AES-128-ECB decryption (`data` a whole number of blocks). */
export function decryptEcb(key: Uint8Array, data: Uint8Array): Uint8Array {
  const rounds = expand(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(rounds, data.subarray(i, i + 16)), i);
  return out;
}

/** AES-128-CBC decryption with a zero IV, no padding removed (MEGA's attributes). */
export function decryptCbc(key: Uint8Array, data: Uint8Array): Uint8Array {
  const rounds = expand(key);
  const out = new Uint8Array(data.length);
  let previous = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    const plain = decryptBlock(rounds, block);
    for (let j = 0; j < 16; j++) out[i + j] = plain[j] ^ previous[j];
    previous = new Uint8Array(block);
  }
  return out;
}
