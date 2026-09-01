export type EccDecodeResult = {
  data: bigint;
  correctedCodeword: bigint;
  syndrome: number;
  corrected: boolean;
  uncorrectable: boolean;
  errorPosition: number | null;
};

const DATA_BITS = 64;
const HAMMING_BITS = 71;
const CODE_BITS = 72;
const parityPositions = new Set([1, 2, 4, 8, 16, 32, 64]);

export function encodeSecded64(data: bigint): bigint {
  let codeword = 0n;
  let dataIndex = 0;
  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    if (parityPositions.has(position)) continue;
    if (((data >> BigInt(dataIndex)) & 1n) === 1n) codeword |= 1n << BigInt(position - 1);
    dataIndex += 1;
  }

  for (let parityIndex = 0; parityIndex < 7; parityIndex += 1) {
    const parityPosition = 1 << parityIndex;
    let parity = 0n;
    for (let position = 1; position <= HAMMING_BITS; position += 1) {
      if ((position & parityPosition) !== 0) parity ^= (codeword >> BigInt(position - 1)) & 1n;
    }
    if (parity === 1n) codeword |= 1n << BigInt(parityPosition - 1);
  }

  if (parityOf(codeword, HAMMING_BITS) === 1) codeword |= 1n << 71n;
  return codeword;
}

export function decodeSecded64(received: bigint): EccDecodeResult {
  let syndrome = 0;
  for (let parityIndex = 0; parityIndex < 7; parityIndex += 1) {
    const parityPosition = 1 << parityIndex;
    let parity = 0n;
    for (let position = 1; position <= HAMMING_BITS; position += 1) {
      if ((position & parityPosition) !== 0) parity ^= (received >> BigInt(position - 1)) & 1n;
    }
    if (parity === 1n) syndrome |= parityPosition;
  }

  const overallMismatch = parityOf(received, CODE_BITS) === 1;
  let correctedCodeword = received;
  let corrected = false;
  let uncorrectable = false;
  let errorPosition: number | null = null;

  if (syndrome !== 0 && overallMismatch) {
    correctedCodeword ^= 1n << BigInt(syndrome - 1);
    corrected = true;
    errorPosition = syndrome;
  } else if (syndrome === 0 && overallMismatch) {
    correctedCodeword ^= 1n << 71n;
    corrected = true;
    errorPosition = 72;
  } else if (syndrome !== 0) {
    uncorrectable = true;
  }

  let data = 0n;
  let dataIndex = 0;
  for (let position = 1; position <= HAMMING_BITS; position += 1) {
    if (parityPositions.has(position)) continue;
    const bit = (correctedCodeword >> BigInt(position - 1)) & 1n;
    data |= bit << BigInt(dataIndex);
    dataIndex += 1;
  }

  return { data, correctedCodeword, syndrome, corrected, uncorrectable, errorPosition };
}

export function buildLaneRepairMap(lanes: number, spares: number, failedLanes: number[]) {
  const failures = [...new Set(failedLanes)].filter((lane) => lane >= 0 && lane < lanes).sort((a, b) => a - b);
  const mapping = Array.from({ length: lanes }, (_, logicalLane) => {
    const failureIndex = failures.indexOf(logicalLane);
    return failureIndex >= 0 && failureIndex < spares ? lanes + failureIndex : logicalLane;
  });
  return {
    repairable: failures.length <= spares,
    failures,
    mapping,
    utilizedSpares: Math.min(failures.length, spares),
  };
}

export function generateGatherAddresses(base: bigint, strideBytes: number, count: number) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => base + BigInt(index * strideBytes));
}

export function runReliabilityCampaign() {
  const patterns = [0n, 1n, 0xffffffffffffffffn, 0xa5a5a5a55a5a5a5an, 0x0123456789abcdefn];
  let singleBitInjections = 0;
  let singleBitCorrections = 0;
  let doubleBitInjections = 0;
  let doubleBitDetections = 0;

  for (const pattern of patterns) {
    const encoded = encodeSecded64(pattern);
    for (let bit = 0; bit < CODE_BITS; bit += 1) {
      singleBitInjections += 1;
      const decoded = decodeSecded64(encoded ^ (1n << BigInt(bit)));
      if (decoded.corrected && !decoded.uncorrectable && decoded.data === pattern) singleBitCorrections += 1;
    }
  }

  const encoded = encodeSecded64(patterns[4]);
  for (let first = 0; first < CODE_BITS; first += 1) {
    for (let second = first + 1; second < CODE_BITS; second += 1) {
      doubleBitInjections += 1;
      const decoded = decodeSecded64(encoded ^ (1n << BigInt(first)) ^ (1n << BigInt(second)));
      if (decoded.uncorrectable) doubleBitDetections += 1;
    }
  }

  return {
    singleBitInjections,
    singleBitCorrections,
    doubleBitInjections,
    doubleBitDetections,
    singleBitCorrectionPercent: singleBitCorrections / singleBitInjections * 100,
    doubleBitDetectionPercent: doubleBitDetections / doubleBitInjections * 100,
    laneRepairCases: [
      buildLaneRepairMap(64, 2, []),
      buildLaneRepairMap(64, 2, [7]),
      buildLaneRepairMap(64, 2, [7, 41]),
      buildLaneRepairMap(64, 2, [7, 41, 52]),
    ],
    gatherReference: generateGatherAddresses(0x1000n, 128, 8).map((address) => `0x${address.toString(16)}`),
  };
}

function parityOf(value: bigint, bits: number) {
  let parity = 0;
  for (let bit = 0; bit < bits; bit += 1) parity ^= Number((value >> BigInt(bit)) & 1n);
  return parity;
}

export const SECCDED_PARAMETERS = { dataBits: DATA_BITS, codeBits: CODE_BITS, parityBits: CODE_BITS - DATA_BITS } as const;
