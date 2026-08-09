const fs = require('fs');
const path = require('path');

console.log('Building frequency list from Google Web Corpus...');

const INPUT_FILE = path.join(__dirname, 'unigram_freq.csv');
const OUTPUT_FILE = path.join(__dirname, '../data/frequencyList.js');

const MAX_WORDS = 100000;

function buildFrequencyList() {
  try {
    const data = fs.readFileSync(INPUT_FILE, 'utf8');
    const lines = data.split('\n');
    
    console.log(`Processing ${lines.length} lines from CSV...`);
    
    const frequencyList = {};
    let processedCount = 0;
    let skippedCount = 0;
    
    for (let i = 1; i < lines.length && processedCount < MAX_WORDS; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const parts = line.split(',');
      if (parts.length < 2) continue;
      
      const word = parts[0]?.trim()?.toLowerCase();
      const countStr = parts[1]?.trim();
      
      if (!word || !countStr) continue;
      if (word.length < 2 || !/^[a-z]+$/.test(word)) {
        skippedCount++;
        continue;
      }
      
      const count = parseInt(countStr, 10);
      if (isNaN(count)) continue;
      
      frequencyList[word] = processedCount + 1;
      processedCount++;
      
      if (processedCount % 10000 === 0) {
        console.log(`Processed ${processedCount} words...`);
      }
    }
    
    console.log(`\nBuild complete!`);
    console.log(`- Processed: ${processedCount} words`);
    console.log(`- Skipped: ${skippedCount} words`);
    console.log(`- Total words in frequency list: ${Object.keys(frequencyList).length}`);
    
    const output = `// Generated from Google Web Corpus via Kaggle. Do not edit manually.
// Total words: ${Object.keys(frequencyList).length}
// Source: unigram_freq.csv
const FREQUENCY_LIST = ${JSON.stringify(frequencyList, null, 2)};

function getFrequencyRank(word) {
  return FREQUENCY_LIST[word.toLowerCase().trim()] ?? 99999;
}

module.exports = { FREQUENCY_LIST, getFrequencyRank };`;
    
    fs.writeFileSync(OUTPUT_FILE, output, 'utf8');
    console.log(`\nWritten to: ${OUTPUT_FILE}`);
    
    return {
      totalWords: Object.keys(frequencyList).length,
      processedWords: processedCount,
      skippedWords: skippedCount
    };
    
  } catch (error) {
    console.error('Error building frequency list:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  buildFrequencyList();
}
