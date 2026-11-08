// Pre-program a classic chiptune melody!
const mel = ["C-4", "E-4", "G-4", "B-4", "C-5", "B-4", "G-4", "E-4"];

// Generate initial empty notes or preset chiptunes
export const INITIAL_PATTERNS = Array.from({ length: 64 }, (_, rowIndex) => {
  const rowData: { [key: number]: { note: string; inst: string; vol: string; delay: string } } = {};
  
  // Fill first 8 channels with some musical loops
  for (let ch = 1; ch <= 8; ch++) {
    let note = "---";
    if (ch === 1 && rowIndex % 4 === 0) {
      note = mel[(rowIndex / 4) % mel.length];
    } else if (ch === 2 && rowIndex % 4 === 2) {
      note = mel[((rowIndex / 4) + 2) % mel.length];
    } else if (ch === 6 && rowIndex % 4 === 0) {
      // Bass drum on DAC channel 6
      note = "C-3";
    } else if (ch === 3 && rowIndex % 8 === 4) {
      // Snare drum on SID channel 3
      note = "F-3";
    } else if (ch === 5 && rowIndex % 2 === 1) {
      // Arp helper
      note = "G-5";
    }
    
    rowData[ch] = {
      note: note,
      inst: note !== "---" ? "01" : "..",
      vol: note !== "---" ? "80" : "..",
      delay: "000"
    };
  }

  // Clear slots for remaining 40 channels
  for (let ch = 9; ch <= 48; ch++) {
    rowData[ch] = { note: "---", inst: "..", vol: "..", delay: "000" };
  }
  return rowData;
});
