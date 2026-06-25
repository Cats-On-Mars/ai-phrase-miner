// 应用状态
let state = {
  mode: 'generate', // 'extract', 'generate', 'vocabulary', 'articles', 'review', 'translate', 'translateHistory'
  input: '',
  inputType: 'text',
  apiKey: '',
  apiKeyInput: '',
  showApiSettings: false,
  phrases: [],
  generatedPhrases: [],
  vocabulary: [],
  articles: [], // 短文簿
  selectedArticle: null, // 当前查看的文章
  selectedVocabDate: 'all', // 选中的单词本日期筛选，'all' 表示全部
  showVocabDatePicker: false, // 是否显示日期选择器
  reviewWords: [], // 今日需要复习的单词
  // 翻译/沉浸式阅读
  translateInput: '', // 翻译模式输入文本
  translateWordMap: {}, // 预处理的短语释义 { phrase: { pos, phonetic, meaning } }
  translateOriginalText: '', // 原始文章文本
  translateReady: false, // 是否已完成预处理
  newWords: [], // 生词区: [{ word: '短语', pos: '...', phonetic: '...', meaning: '...' }]
  newWordPhrases: {}, // 已生成例句: { phrase: ["例句1", "例句2"] }
  newWordPhraseGenerated: new Set(), // 已经生成过例句的短语（置灰用）
  generatingNewWordPhrases: false, // 是否正在生成例句
  // 翻译记录
  translateRecords: [], // [{ id, title, timestamp, date, originalText, wordMap, newWords, newWordPhrases, newWordPhraseGenerated }]
  currentTranslateRecordId: null, // 当前关联的翻译记录ID
  loading: false,
  error: '',
  copied: false,
  showToast: false,
  toastMessage: ''
};

const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DASHSCOPE_MODEL = 'qwen3.7-plus';

// 从本地存储加载用户自己的API Key。不要在公开仓库中硬编码密钥。
async function loadApiKey() {
  try {
    const result = await chrome.storage.local.get('dashscopeApiKey');
    state.apiKey = result.dashscopeApiKey || '';
    state.apiKeyInput = state.apiKey;
    render();
  } catch (err) {
    console.log('加载API Key失败:', err);
  }
}

async function saveApiKey() {
  const apiKey = state.apiKeyInput.trim();
  if (!apiKey) {
    state.error = '请输入 DashScope API Key';
    render();
    return;
  }

  try {
    await chrome.storage.local.set({ dashscopeApiKey: apiKey });
    state.apiKey = apiKey;
    state.apiKeyInput = apiKey;
    state.showApiSettings = false;
    state.error = '';
    showSuccessToast('API Key 已保存');
  } catch (err) {
    state.error = '保存API Key失败: ' + (err.message || '未知错误');
    render();
  }
}

async function clearApiKey() {
  try {
    await chrome.storage.local.remove('dashscopeApiKey');
    state.apiKey = '';
    state.apiKeyInput = '';
    state.showApiSettings = true;
    showSuccessToast('API Key 已清除');
  } catch (err) {
    state.error = '清除API Key失败: ' + (err.message || '未知错误');
    render();
  }
}

function ensureApiKey() {
  if (state.apiKey.trim()) return true;
  state.showApiSettings = true;
  state.error = '请先填写 DashScope API Key';
  render();
  return false;
}

async function callDashScope(messages) {
  if (!state.apiKey.trim()) {
    throw new Error('请先填写 DashScope API Key');
  }

  return fetch(DASHSCOPE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: DASHSCOPE_MODEL,
      messages
    })
  });
}

// 从Chrome存储加载短文簿
async function loadArticles() {
  try {
    const result = await chrome.storage.local.get(null);
    const articleItems = Object.keys(result)
      .filter(key => key.startsWith('article_'))
      .map(key => JSON.parse(result[key]))
      .sort((a, b) => b.timestamp - a.timestamp);
    state.articles = articleItems;
    render();
  } catch (err) {
    console.log('加载短文簿失败:', err);
  }
}

// 保存到短文簿
async function saveToArticles(text, phrases) {
  try {
    const timestamp = Date.now();
    const articleItem = {
      id: `article_${timestamp}`,
      title: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      content: text,
      phrases: phrases,
      timestamp,
      date: new Date().toLocaleString('zh-CN'),
      phraseCount: phrases.length
    };
    
    await chrome.storage.local.set({ [`article_${timestamp}`]: JSON.stringify(articleItem) });
    await loadArticles();
  } catch (err) {
    console.error('保存到短文簿失败:', err);
  }
}

// 删除文章
async function deleteArticle(id) {
  try {
    await chrome.storage.local.remove(id);
    if (state.selectedArticle && state.selectedArticle.id === id) {
      state.selectedArticle = null;
    }
    await loadArticles();
  } catch (err) {
    console.error('删除失败:', err);
  }
}

// 查看文章详情
function viewArticle(article) {
  state.selectedArticle = article;
  render();
}

// 加载单词本
async function loadVocabulary() {
  try {
    const result = await chrome.storage.local.get('vocabulary');
    if (result.vocabulary) {
      state.vocabulary = JSON.parse(result.vocabulary);
      
      // 兼容旧数据：为没有reviewStatus的单词初始化复习状态
      // 或者修复使用旧复习时间的单词（2,4,7,15,30 -> 1,3,6,14,29）
      let needsSave = false;
      state.vocabulary.forEach(item => {
        if (!item.reviewStatus) {
          // 完全没有reviewStatus，初始化
          item.reviewStatus = [
            { day: 0, completed: true, completedDate: item.timestamp },
            { day: 1, completed: false, completedDate: null },
            { day: 3, completed: false, completedDate: null },
            { day: 6, completed: false, completedDate: null },
            { day: 14, completed: false, completedDate: null },
            { day: 29, completed: false, completedDate: null }
          ];
          item.nextReviewDay = 1;
          needsSave = true;
        } else if (item.reviewStatus.length === 6 && item.reviewStatus[1].day === 2) {
          // 使用了旧的复习时间，需要更新
          const oldStatus = item.reviewStatus;
          item.reviewStatus = [
            oldStatus[0], // 保留第一个（已学习）
            { day: 1, completed: oldStatus[1].completed, completedDate: oldStatus[1].completedDate },
            { day: 3, completed: oldStatus[2].completed, completedDate: oldStatus[2].completedDate },
            { day: 6, completed: oldStatus[3].completed, completedDate: oldStatus[3].completedDate },
            { day: 14, completed: oldStatus[4].completed, completedDate: oldStatus[4].completedDate },
            { day: 29, completed: oldStatus[5].completed, completedDate: oldStatus[5].completedDate }
          ];
          // 重新计算nextReviewDay
          const daysSince = getDaysSinceAdded(item.timestamp);
          const nextReview = item.reviewStatus.find((r, idx) => idx > 0 && !r.completed);
          if (nextReview) {
            item.nextReviewDay = nextReview.day;
          } else {
            item.nextReviewDay = 999;
          }
          needsSave = true;
        }
      });
      
      // 自动顺延逻辑：检查所有单词，如果错过了复习日期，自动顺延
      state.vocabulary.forEach(item => {
        if (!item.reviewStatus || item.nextReviewDay >= 999) return;
        
        const daysSince = getDaysSinceAdded(item.timestamp);
        const originalSchedule = [0, 1, 3, 6, 14, 29];
        
        // 首先，修复已完成复习的day值（如果它们是在顺延后完成的）
        for (let i = 0; i < item.reviewStatus.length; i++) {
          const review = item.reviewStatus[i];
          if (review.completed && review.completedDate) {
            // 计算从添加日期到完成日期的天数差
            const actualCompletedDay = getDaysBetween(item.timestamp, review.completedDate);
            
            if (review.day !== actualCompletedDay) {
              review.day = actualCompletedDay;
              needsSave = true;
            }
          }
        }
        
        // 找到第一个未完成的复习
        const firstIncompleteIdx = item.reviewStatus.findIndex((r, idx) => 
          idx > 0 && !r.completed
        );
        
        if (firstIncompleteIdx > 0) {
          const firstIncomplete = item.reviewStatus[firstIncompleteIdx];
          
          // 检查是否需要顺延：当前天数 >= 第一个未完成复习的原始计划天数
          const originalDay = originalSchedule[firstIncompleteIdx];
          
          if (daysSince >= originalDay) {
            // 找到上一次复习（可能是已完成的）
            const prevReview = item.reviewStatus[firstIncompleteIdx - 1];
            let baseDay;
            
            if (prevReview.completed) {
              // 如果上一次已完成，基于上一次的实际完成天数（已经在上面修复过了）
              baseDay = prevReview.day;
            } else {
              // 如果上一次未完成（不应该发生，但以防万一）
              baseDay = 0;
            }
            
            // 计算第一个未完成复习应该在哪天
            // 如果错过了原始计划，顺延到今天；否则保持原计划
            const originalIntervalFromPrev = originalSchedule[firstIncompleteIdx] - originalSchedule[firstIncompleteIdx - 1];
            const plannedDay = baseDay + originalIntervalFromPrev;
            const newFirstDay = Math.max(daysSince, plannedDay);
            
            // 只有当日期需要改变时才更新
            if (firstIncomplete.day !== newFirstDay) {
              firstIncomplete.day = newFirstDay;
              needsSave = true;
            }
            
            // 重新计算所有后续未完成复习的日期
            for (let j = firstIncompleteIdx + 1; j < item.reviewStatus.length; j++) {
              if (!item.reviewStatus[j].completed) {
                // 计算原始间隔：当前阶段 - 上一阶段
                const originalInterval = originalSchedule[j] - originalSchedule[j - 1];
                // 新日期 = 上一次的日期 + 原始间隔
                const newDay = item.reviewStatus[j - 1].day + originalInterval;
                
                if (item.reviewStatus[j].day !== newDay) {
                  item.reviewStatus[j].day = newDay;
                  needsSave = true;
                }
              }
            }
            
            // 更新nextReviewDay
            if (item.nextReviewDay !== firstIncomplete.day) {
              item.nextReviewDay = firstIncomplete.day;
              needsSave = true;
            }
          }
        }
      });
      
      // 如果有旧数据被初始化或顺延，保存到存储
      if (needsSave) {
        await saveVocabulary();
      }
    }
    render();
  } catch (err) {
    console.log('加载单词本失败:', err);
  }
}

// 保存单词本
async function saveVocabulary() {
  try {
    await chrome.storage.local.set({ vocabulary: JSON.stringify(state.vocabulary) });
  } catch (err) {
    console.error('保存单词本失败:', err);
  }
}

// 添加到单词本
async function addToVocabulary(phrase, meaning, examples, phonetic = '') {
  // 确保examples是数组，最多保留两个例句
  let exampleArray = [];
  if (typeof examples === 'string') {
    exampleArray = examples ? [examples] : [];
  } else if (Array.isArray(examples)) {
    exampleArray = examples.slice(0, 2);
  }
  
  const now = Date.now();
  const vocabularyItem = {
    id: `vocab_${now}`,
    phrase,
    phonetic,
    meaning,
    examples: exampleArray,
    addedDate: new Date().toLocaleString('zh-CN'),
    timestamp: now,
    // 复习系统
    reviewStatus: [
      { day: 0, completed: true, completedDate: now }, // 添加时算第一次学习
      { day: 1, completed: false, completedDate: null },
      { day: 3, completed: false, completedDate: null },
      { day: 6, completed: false, completedDate: null },
      { day: 14, completed: false, completedDate: null },
      { day: 29, completed: false, completedDate: null }
    ],
    nextReviewDay: 1 // 下次复习是第几天
  };
  
  // 检查是否已存在
  const exists = state.vocabulary.some(item => item.phrase === phrase);
  if (exists) {
    showSuccessToast('该短语已在单词本中');
    return;
  }
  
  state.vocabulary.unshift(vocabularyItem);
  await saveVocabulary();
  showSuccessToast('已添加到单词本');
  render();
}

// 从单词本删除
async function removeFromVocabulary(id) {
  state.vocabulary = state.vocabulary.filter(item => item.id !== id);
  await saveVocabulary();
  showSuccessToast('已从单词本移除');
  render();
}

// 计算单词已学习天数（按自然日计算）
function getDaysSinceAdded(timestamp) {
  const addedDate = new Date(timestamp);
  const today = new Date();
  
  // 将时间设置为当天的0点，只比较日期
  const addedDay = new Date(addedDate.getFullYear(), addedDate.getMonth(), addedDate.getDate());
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  
  // 计算天数差
  const diff = currentDay.getTime() - addedDay.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// 计算两个时间戳之间的天数差（按自然日计算）
function getDaysBetween(timestamp1, timestamp2) {
  const date1 = new Date(timestamp1);
  const date2 = new Date(timestamp2);
  
  // 将时间设置为当天的0点，只比较日期
  const day1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const day2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
  
  // 计算天数差
  const diff = day2.getTime() - day1.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// 获取今日需要复习的单词
function getTodayReviewWords() {
  return state.vocabulary.filter(item => {
    // 兼容旧数据：如果没有reviewStatus，说明还没初始化，跳过
    if (!item.reviewStatus) {
      return false;
    }
    
    const daysSince = getDaysSinceAdded(item.timestamp);
    const nextReviewDay = item.nextReviewDay || 1; // 默认第1天复习
    
    // 如果已经到了或超过下次复习日期，且还有未完成的复习
    return daysSince >= nextReviewDay && nextReviewDay <= 29;
  });
}

// 标记单词为已复习
async function markAsReviewed(vocabId) {
  const item = state.vocabulary.find(v => v.id === vocabId);
  if (!item || !item.reviewStatus) return;
  
  const daysSince = getDaysSinceAdded(item.timestamp);
  const now = Date.now();
  
  // 找到当前应该完成的复习（第一个未完成的）
  const firstIncompleteIdx = item.reviewStatus.findIndex((r, idx) => 
    idx > 0 && !r.completed
  );
  
  if (firstIncompleteIdx > 0) {
    const review = item.reviewStatus[firstIncompleteIdx];
    
    // 标记为已完成
    review.completed = true;
    review.completedDate = now;
    // 重要：将这次复习的day更新为实际完成的天数
    review.day = daysSince;
    
    // 重新计算所有后续未完成复习的日期
    // 基于当前实际复习的天数（daysSince）
    // 原始的复习计划：day 0, 1, 3, 6, 14, 29
    // 间隔分别是：1-0=1, 3-1=2, 6-3=3, 14-6=8, 29-14=15
    const originalSchedule = [0, 1, 3, 6, 14, 29];
    
    for (let j = firstIncompleteIdx + 1; j < item.reviewStatus.length; j++) {
      if (!item.reviewStatus[j].completed) {
        // 计算原始间隔：当前阶段 - 上一阶段
        const originalInterval = originalSchedule[j] - originalSchedule[j - 1];
        // 新日期 = 上一次的日期 + 原始间隔（上一次的day现在是daysSince）
        item.reviewStatus[j].day = item.reviewStatus[j - 1].day + originalInterval;
      }
    }
    
    // 更新nextReviewDay为下一个未完成的复习日期
    const nextReview = item.reviewStatus.find((r, idx) => idx > firstIncompleteIdx && !r.completed);
    if (nextReview) {
      item.nextReviewDay = nextReview.day;
    } else {
      item.nextReviewDay = 999; // 全部完成
    }
  }
  
  await saveVocabulary();
  // 更新复习列表
  state.reviewWords = getTodayReviewWords();
  showSuccessToast('已标记为复习完成');
  render();
}

// 获取单词本的所有日期列表（按日期分组）
function getVocabularyDates() {
  const dates = new Set();
  state.vocabulary.forEach(item => {
    if (item.addedDate) {
      // 提取日期部分（去掉时间）
      const dateOnly = item.addedDate.split(' ')[0];
      dates.add(dateOnly);
    }
  });
  return Array.from(dates).sort((a, b) => {
    // 按日期降序排列（最新的在前）
    return new Date(b.replace(/\//g, '-')) - new Date(a.replace(/\//g, '-'));
  });
}

// 根据日期筛选单词本
function getFilteredVocabulary() {
  if (state.selectedVocabDate === 'all') {
    return state.vocabulary;
  }
  return state.vocabulary.filter(item => {
    const dateOnly = item.addedDate ? item.addedDate.split(' ')[0] : '';
    return dateOnly === state.selectedVocabDate;
  });
}

// 导出单词本
function exportVocabulary() {
  if (state.vocabulary.length === 0) {
    alert('单词本为空，无法导出');
    return;
  }
  
  try {
    let markdown = '# 📚 我的英语单词本\n\n';
    markdown += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
    markdown += `> 共收录 ${state.vocabulary.length} 个短语\n\n`;
    markdown += '\n\n\n';
    
    state.vocabulary.forEach((item, index) => {
      markdown += `## ${item.phrase}\n\n`;
      if (item.phonetic) {
        markdown += `**音标:** ${item.phonetic}\n\n`;
      }
      markdown += `**释义:** ${item.meaning}\n\n`;
      markdown += `**例句:**\n`;
      if (item.examples && item.examples.length > 0) {
        item.examples.forEach((ex, i) => {
          if (typeof ex === 'string') {
            markdown += `> ${i + 1}. ${ex}\n`;
          } else {
            markdown += `> ${i + 1}. ${ex.en}\n>    ${ex.zh}\n`;
          }
        });
      } else {
        markdown += `> 暂无例句\n`;
      }
      markdown += '\n\n\n';
    });
    
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `我的单词本_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSuccessToast('单词本导出成功!');
  } catch (err) {
    console.error('导出失败:', err);
    alert('导出失败，请重试');
  }
}

// ========== 翻译/沉浸式阅读功能 ==========

// 虚词列表（不显示tooltip）
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'and', 'or', 'but', 'nor', 'for', 'yet', 'so',
  'in', 'on', 'at', 'to', 'of', 'by', 'with', 'from', 'up', 'about', 'into',
  'over', 'after', 'before', 'between', 'under', 'above', 'below',
  'that', 'this', 'these', 'those', 'it', 'its',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'they', 'them', 'their', 'theirs', 'who', 'whom', 'whose', 'which', 'what',
  'if', 'then', 'else', 'when', 'where', 'how', 'why',
  'not', 'no', 'yes', 'as', 'than', 'too', 'very', 'just',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'any',
  'such', 'only', 'own', 'same', 'so', 'also', 'here', 'there'
]);

// 判断是否是虚词
function isFunctionWord(word) {
  return FUNCTION_WORDS.has(word.toLowerCase());
}

// 提取文章中的唯一实词
function extractContentWords(text) {
  const words = text.match(/[a-zA-Z]+/g) || [];
  const unique = new Set();
  words.forEach(w => {
    const lower = w.toLowerCase();
    if (lower.length > 1 && !isFunctionWord(lower)) {
      unique.add(lower);
    }
  });
  return Array.from(unique);
}

// 批量调用AI提取短语并逐词翻译
async function batchTranslateWords(text) {
  if (!ensureApiKey()) return;

  if (!text.trim()) {
    state.error = '请输入英文文本';
    render();
    return;
  }

  state.loading = true;
  state.error = '';
  state.translateReady = false;
  state.translateWordMap = {};
  state.translateOriginalText = text;
  state.newWords = [];
  state.newWordPhrases = {};
  render();

  try {
    // ===== 第一阶段：提取短语 =====
    const segmentSize = 1500;
    const segments = [];
    for (let i = 0; i < text.length; i += segmentSize) {
      segments.push(text.substring(i, i + segmentSize));
    }

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const response = await callDashScope([
        {
          role: 'user',
          content: `你是一个英语短语专家。请从以下英文文本中提取所有有学习价值的短语、搭配、固定表达，并给出在该语境下的中文释义。

英文文本：
${segment}

要求：
1. 提取短语、动词搭配、介词搭配、固定表达、习语等（如 take advantage of, in terms of, carry out 等）
2. 也可以提取有学习价值的单个实义词（名词、形容词、副词等），但常见简单词（如 good, big, go, like）不要提取
3. 短语必须是文本中原文出现的，保持原文中的形式
4. 每个短语标注词性（phrase/n./v./adj./adv. 等）
5. 每个短语标注音标（如果是多词短语，标注核心词的音标）
6. 释义简短精炼
7. 返回纯JSON对象，key为短语小写，value为 { "pos": "词性", "phonetic": "/音标/", "meaning": "中文释义" }
8. 不要有任何markdown标记

示例格式：
{
  "take advantage of": { "pos": "phrase", "phonetic": "/ədˈvæntɪdʒ/", "meaning": "利用" },
  "tremendous": { "pos": "adj.", "phonetic": "/trɪˈmendəs/", "meaning": "巨大的" },
  "in terms of": { "pos": "phrase", "phonetic": "/tɜːrmz/", "meaning": "就…而言" }
}`
        }
      ]);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error?.message || `API请求失败: ${response.status}`);
      }

      const data = await response.json();
      const resultText = data.choices?.[0]?.message?.content || '';
      if (!resultText) throw new Error('API返回内容为空');

      const cleanText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();
      try {
        const parsed = JSON.parse(cleanText);
        Object.keys(parsed).forEach(key => {
          state.translateWordMap[key.toLowerCase()] = parsed[key];
        });
      } catch (e) {
        console.error('短语JSON解析错误:', e, '原始:', resultText);
      }
    }

    // ===== 第二阶段：逐词翻译（补充短语未覆盖的单词） =====
    const words = extractContentWords(text);
    // 过滤掉已经在短语Map中的单词
    const wordsToTranslate = words.filter(w => !state.translateWordMap[w]);
    if (wordsToTranslate.length > 0) {
      const context = text.substring(0, 500);
      const batchSize = 60;
      const wordBatches = [];
      for (let i = 0; i < wordsToTranslate.length; i += batchSize) {
        wordBatches.push(wordsToTranslate.slice(i, i + batchSize));
      }

      for (const batch of wordBatches) {
        const response = await callDashScope([
          {
            role: 'user',
            content: `你是一个英语词典。请根据以下文章上下文，为每个英文单词给出在该语境下最准确的中文释义和词性。

文章上下文（前500字）：
${context}

需要翻译的单词列表：
${batch.join(', ')}

要求：
1. 根据文章上下文判断多义词的正确含义
2. 每个单词标注词性（n./v./adj./adv./prep./conj. 等）
3. 每个单词标注音标
4. 释义简短精炼，通常2-6个字
5. 返回纯JSON对象，key为单词小写，value为 { "pos": "词性", "phonetic": "/音标/", "meaning": "中文释义" }
6. 不要有任何markdown标记

示例格式：
{
  "bank": { "pos": "n.", "phonetic": "/bæŋk/", "meaning": "银行" },
  "run": { "pos": "v.", "phonetic": "/rʌn/", "meaning": "运行" }
}`
          }
        ]);

        if (!response.ok) continue; // 跳过失败的批次

        const data = await response.json();
        const resultText = data.choices?.[0]?.message?.content || '';
        if (!resultText) continue;

        const cleanText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        try {
          const parsed = JSON.parse(cleanText);
          Object.keys(parsed).forEach(key => {
            const lower = key.toLowerCase();
            // 不覆盖已有的短语
            if (!state.translateWordMap[lower]) {
              state.translateWordMap[lower] = parsed[key];
            }
          });
        } catch (e) {
          console.error('单词翻译JSON解析错误:', e);
        }
      }
    }

    state.translateReady = true;
    // 保存翻译记录
    await saveNewTranslateRecord(text);
  } catch (err) {
    state.error = '翻译失败: ' + (err.message || '未知错误');
    console.error('翻译错误:', err);
  } finally {
    state.loading = false;
    render();
  }
}

// ========== 翻译记录管理 ==========

// 加载翻译记录
async function loadTranslateRecords() {
  try {
    const result = await chrome.storage.local.get(null);
    const records = Object.keys(result)
      .filter(key => key.startsWith('translate_'))
      .map(key => {
        const r = JSON.parse(result[key]);
        // 恢复 Set
        if (r.newWordPhraseGenerated && Array.isArray(r.newWordPhraseGenerated)) {
          r.newWordPhraseGenerated = new Set(r.newWordPhraseGenerated);
        } else {
          r.newWordPhraseGenerated = new Set();
        }
        return r;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
    state.translateRecords = records;
  } catch (err) {
    console.log('加载翻译记录失败:', err);
  }
}

// 保存新翻译记录
async function saveNewTranslateRecord(text) {
  try {
    const timestamp = Date.now();
    const id = `translate_${timestamp}`;
    const record = {
      id,
      title: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      timestamp,
      date: new Date().toLocaleString('zh-CN'),
      originalText: text,
      wordMap: state.translateWordMap,
      newWords: state.newWords,
      newWordPhrases: state.newWordPhrases,
      newWordPhraseGenerated: Array.from(state.newWordPhraseGenerated)
    };
    state.currentTranslateRecordId = id;
    await chrome.storage.local.set({ [id]: JSON.stringify(record) });
    await loadTranslateRecords();
  } catch (err) {
    console.error('保存翻译记录失败:', err);
  }
}

// 更新当前翻译记录（添加生词、生成短语后调用）
async function saveCurrentTranslateRecord() {
  if (!state.currentTranslateRecordId) return;
  try {
    const existing = state.translateRecords.find(r => r.id === state.currentTranslateRecordId);
    if (!existing) return;
    const updated = {
      ...existing,
      newWords: state.newWords,
      newWordPhrases: state.newWordPhrases,
      newWordPhraseGenerated: Array.from(state.newWordPhraseGenerated)
    };
    await chrome.storage.local.set({ [state.currentTranslateRecordId]: JSON.stringify(updated) });
    await loadTranslateRecords();
  } catch (err) {
    console.error('更新翻译记录失败:', err);
  }
}

// 恢复翻译记录到沉浸式阅读界面
function restoreTranslateRecord(record) {
  state.mode = 'translate';
  state.translateOriginalText = record.originalText;
  state.translateWordMap = record.wordMap || {};
  state.newWords = record.newWords || [];
  state.newWordPhrases = record.newWordPhrases || {};
  state.newWordPhraseGenerated = (record.newWordPhraseGenerated instanceof Set)
    ? record.newWordPhraseGenerated
    : new Set(record.newWordPhraseGenerated || []);
  state.translateReady = true;
  state.currentTranslateRecordId = record.id;
  state.translateFromHistory = true;
  state.error = '';
  render();
}

// 删除翻译记录
async function deleteTranslateRecord(id) {
  try {
    await chrome.storage.local.remove(id);
    if (state.currentTranslateRecordId === id) {
      state.currentTranslateRecordId = null;
    }
    await loadTranslateRecords();
    render();
  } catch (err) {
    console.error('删除翻译记录失败:', err);
  }
}

// 导出翻译结果为Markdown
function exportTranslateMarkdown() {
  try {
    let md = '# 沉浸式阅读笔记\n\n';
    md += `> 导出时间: ${new Date().toLocaleString('zh-CN')}\n\n`;

    // 原文
    md += '## 📖 英文原文\n\n';
    md += state.translateOriginalText + '\n\n';

    // 短语释义表
    const phraseKeys = Object.keys(state.translateWordMap).sort();
    if (phraseKeys.length > 0) {
      md += '## 📝 短语释义\n\n';
      md += '| 短语 | 音标 | 词性 | 释义 |\n';
      md += '|------|------|------|------|\n';
      phraseKeys.forEach(w => {
        const info = state.translateWordMap[w];
        md += `| ${w} | ${info.phonetic || ''} | ${info.pos || ''} | ${info.meaning || ''} |\n`;
      });
      md += '\n';
    }

    // 生词列表
    if (state.newWords.length > 0) {
      md += '## ⭐ 生词列表\n\n';
      state.newWords.forEach((w, i) => {
        md += `${i + 1}. **${w.word}** ${w.phonetic || ''} _${w.pos}_ ${w.meaning}\n`;
      });
      md += '\n';
    }

    // 生成的例句
    const phrasedWords = state.newWords.filter(w => state.newWordPhrases[w.word]);
    if (phrasedWords.length > 0) {
      md += '## 💡 例句\n\n';
      phrasedWords.forEach(w => {
        md += `### ${w.word} (${w.pos} ${w.meaning})\n\n`;
        const examples = state.newWordPhrases[w.word] || [];
        if (Array.isArray(examples)) {
          examples.forEach((ex, idx) => {
            if (typeof ex === 'string') {
              md += `${idx + 1}. ${ex}\n`;
            } else {
              md += `${idx + 1}. ${ex.en}\n   > ${ex.zh}\n`;
            }
          });
        }
        md += '\n';
      });
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `沉浸式阅读_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSuccessToast('导出成功!');
  } catch (err) {
    console.error('导出失败:', err);
    alert('导出失败，请重试');
  }
}

// 处理文件上传
function handleTranslateFileUpload(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    state.translateInput = e.target.result;
    render();
  };
  reader.readAsText(file);
}

// 添加生词到生词区
function addNewWord(word, pos, phonetic, meaning) {
  const lower = word.toLowerCase();
  // 避免重复
  if (state.newWords.some(w => w.word === lower)) return;
  state.newWords.push({ word: lower, pos, phonetic: phonetic || '', meaning });
  // 自动保存到当前翻译记录
  saveCurrentTranslateRecord();
  render();
}

// 从生词区移除
function removeNewWord(word) {
  state.newWords = state.newWords.filter(w => w.word !== word);
  saveCurrentTranslateRecord();
  render();
}

// 批量为生词区的短语生成例句
async function generateNewWordPhrases() {
  if (!ensureApiKey()) return;

  // 过滤掉已经生成过例句的短语
  const wordsToGenerate = state.newWords.filter(w => !state.newWordPhraseGenerated.has(w.word));
  if (wordsToGenerate.length === 0) {
    showSuccessToast('所有短语的例句已生成过');
    return;
  }

  state.generatingNewWordPhrases = true;
  state.error = '';
  render();

  try {
    const phraseList = wordsToGenerate.map(w => `${w.word} (${w.meaning})`).join('\n');
    const response = await callDashScope([
      {
        role: 'user',
        content: `请为以下英文短语各生成2个实用例句。

短语列表：
${phraseList}

要求：
1. 每个短语生成2个例句，例句要自然地道，体现短语的用法，每个例句附上中文翻译
2. 返回纯JSON对象，key为短语小写，value为例句数组（2个对象，每个含en和zh字段）
3. 不要有任何markdown标记

格式：
{
  "take advantage of": [{"en": "We should take advantage of the good weather.", "zh": "我们应该利用好天气。"}, {"en": "She took advantage of the opportunity to study abroad.", "zh": "她抓住了出国留学的机会。"}],
  "in terms of": [{"en": "In terms of quality, this product is the best.", "zh": "就质量而言，这个产品是最好的。"}, {"en": "The project was successful in terms of meeting deadlines.", "zh": "该项目在按时完成方面是成功的。"}]
}`
      }
    ]);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error?.message || `API请求失败: ${response.status}`);
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content || '';
    if (!resultText) throw new Error('API返回内容为空');

    const cleanText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();
    try {
      const parsed = JSON.parse(cleanText);
      Object.keys(parsed).forEach(key => {
        const lower = key.toLowerCase();
        state.newWordPhrases[lower] = parsed[key]; // 直接是例句数组
        state.newWordPhraseGenerated.add(lower);
      });
    } catch (e) {
      console.error('例句JSON解析错误:', e);
      state.error = '解析例句结果失败，请重试';
    }
    // 自动将生成了例句的短语添加到单词本
    let addedCount = 0;
    for (const w of wordsToGenerate) {
      const examples = state.newWordPhrases[w.word];
      if (!Array.isArray(examples) || examples.length === 0) continue;
      // 检查是否已在单词本中
      if (state.vocabulary.some(item => item.phrase === w.word)) continue;
      const now = Date.now() + addedCount; // 确保ID唯一
      state.vocabulary.unshift({
        id: `vocab_${now}`,
        phrase: w.word,
        phonetic: w.phonetic || '',
        meaning: w.meaning,
        examples: examples.slice(0, 2),
        addedDate: new Date().toLocaleString('zh-CN'),
        timestamp: now,
        reviewStatus: [
          { day: 0, completed: true, completedDate: now },
          { day: 1, completed: false, completedDate: null },
          { day: 3, completed: false, completedDate: null },
          { day: 6, completed: false, completedDate: null },
          { day: 14, completed: false, completedDate: null },
          { day: 29, completed: false, completedDate: null }
        ],
        nextReviewDay: 1
      });
      addedCount++;
    }
    if (addedCount > 0) {
      await saveVocabulary();
      showSuccessToast(`已生成例句并添加 ${addedCount} 个短语到单词本`);
    }
  } catch (err) {
    state.error = '生成例句失败: ' + (err.message || '未知错误');
    console.error('生成例句错误:', err);
  } finally {
    state.generatingNewWordPhrases = false;
    // 保存到翻译记录
    saveCurrentTranslateRecord();
    render();
  }
}

// 构建沉浸式阅读HTML（支持多词短语匹配）
function buildImmersiveHTML(text) {
  const phrases = Object.keys(state.translateWordMap);
  // 按长度降序排列，优先匹配长短语
  phrases.sort((a, b) => b.length - a.length);

  const lowerText = text.toLowerCase();
  // 标记已匹配的区间 [{start, end, phrase}]
  const marks = [];

  for (const phrase of phrases) {
    const lowerPhrase = phrase.toLowerCase();
    let searchFrom = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerPhrase, searchFrom);
      if (idx === -1) break;

      // 检查词边界（前后不能是字母）
      const before = idx > 0 ? lowerText[idx - 1] : ' ';
      const after = idx + lowerPhrase.length < lowerText.length ? lowerText[idx + lowerPhrase.length] : ' ';
      if (/[a-zA-Z]/.test(before) || /[a-zA-Z]/.test(after)) {
        searchFrom = idx + 1;
        continue;
      }

      // 检查是否与已标记区间重叠
      const end = idx + lowerPhrase.length;
      const overlaps = marks.some(m => !(end <= m.start || idx >= m.end));
      if (!overlaps) {
        marks.push({ start: idx, end, phrase: lowerPhrase });
      }
      searchFrom = idx + 1;
    }
  }

  // 按位置排序
  marks.sort((a, b) => a.start - b.start);

  // 构建HTML
  let html = '';
  let pos = 0;
  for (const mark of marks) {
    // 添加匹配前的文本
    if (mark.start > pos) {
      html += escapeText(text.substring(pos, mark.start));
    }
    // 添加匹配的短语
    const info = state.translateWordMap[mark.phrase];
    const originalText = text.substring(mark.start, mark.end);
    html += `<span class="immersive-word" data-word="${escapeAttr(mark.phrase)}" data-pos="${escapeAttr(info.pos || '')}" data-phonetic="${escapeAttr(info.phonetic || '')}" data-meaning="${escapeAttr(info.meaning || '')}">${escapeHtml(originalText)}</span>`;
    pos = mark.end;
  }
  // 添加剩余文本
  if (pos < text.length) {
    html += escapeText(text.substring(pos));
  }
  return html;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function escapeJsonAttr(value) {
  return escapeAttr(JSON.stringify(value));
}

// HTML转义并保留换行
function escapeText(str) {
  let result = '';
  const text = String(str ?? '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') result += '<br>';
    else if (ch === '&') result += '&amp;';
    else if (ch === '<') result += '&lt;';
    else if (ch === '>') result += '&gt;';
    else if (ch === '"') result += '&quot;';
    else if (ch === "'") result += '&#39;';
    else result += ch;
  }
  return result;
}

function sanitizeRenderedHTML(root) {
  const blockedTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META']);
  root.querySelectorAll('*').forEach((node) => {
    if (blockedTags.has(node.tagName)) {
      node.remove();
      return;
    }

    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || value.startsWith('javascript:')) {
        node.removeAttribute(attr.name);
      }
    });
  });
}

// 生成短语
async function generatePhrases() {
  if (!ensureApiKey()) return;

  if (!state.input.trim()) {
    state.error = '请输入一个英文单词';
    render();
    return;
  }

  state.loading = true;
  state.error = '';
  state.generatedPhrases = [];
  render();

  try {
    const response = await callDashScope([
      {
        role: 'user',
        content: `请为英文单词"${state.input}"提供以下信息：

要求:
1. 单词的音标
2. 单词的中文释义（主要含义）
3. 包含该单词的3-8个常用短语（四级以上水平）
4. 每个短语需要提供:
   - phrase: 短语本身
   - phonetic: 标注输入单词"${state.input}"的音标，格式为"${state.input} /音标/"
   - meaning: 中文释义
   - examples: 2个例句，每个例句包含英文原句和中文翻译
5. 返回格式必须是纯JSON对象,不要有任何markdown标记或其他文字,格式如下:
{
  "word": "单词",
  "phonetic": "/音标/",
  "meaning": "中文释义",
  "phrases": [
    {
      "phrase": "短语1",
      "phonetic": "${state.input} /音标/",
      "meaning": "中文释义",
      "examples": [{"en": "例句1", "zh": "中文翻译1"}, {"en": "例句2", "zh": "中文翻译2"}]
    }
  ]
}`
      }
    ]);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error?.message || `API请求失败: ${response.status}`);
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content || '';
    
    if (!resultText) {
      throw new Error('API返回内容为空');
    }
    
    const cleanText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      const parsedData = JSON.parse(cleanText);
      state.generatedPhrases = parsedData;
    } catch (e) {
      console.error('JSON解析错误:', e);
      console.error('原始返回:', resultText);
      state.error = '解析结果失败,请重试。返回内容: ' + resultText.substring(0, 200);
    }

  } catch (err) {
    state.error = '处理失败: ' + (err.message || '未知错误');
    console.error('生成短语错误:', err);
  } finally {
    state.loading = false;
    render();
  }
}

// 提取短语
async function extractPhrases() {
  if (!ensureApiKey()) return;

  if (!state.input.trim()) {
    state.error = '请输入文章内容';
    render();
    return;
  }

  state.loading = true;
  state.error = '';
  state.phrases = [];
  render();

  try {

    const response = await callDashScope([
      {
        role: 'user',
        content: `请从以下英文文本中提取出所有四级以上水平的英语短语(包括固定搭配、习惯用语、专业术语等)。

要求:
1. 只提取短语,不要提取单个单词
2. 短语应该是2-6个词的固定搭配
3. 水平应该在英语四级以上
4. 按照在文章中出现的顺序排列
5. 每个短语需要提供:
   - phrase: 短语本身
   - phonetic: 必须标注短语中至少一个比较高级或难读的单词的音标，格式为"单词 /音标/"，例如"advantage /ədˈvæntɪdʒ/"。优先选择六级以上或专业词汇，如果都是简单词汇则选择最核心的词
   - meaning: 中文释义
   - contextExample: 文中的例句(包含该短语的完整句子)
   - otherExamples: 其他场景的2个例句(数组格式)
6. 返回格式必须是纯JSON数组,不要有任何markdown标记或其他文字,格式如下:
[
  {
    "phrase": "短语1",
    "phonetic": "difficult /ˈdɪfɪkəlt/",
    "meaning": "中文释义",
    "contextExample": "文中包含该短语的句子",
    "otherExamples": ["例句1", "例句2"]
  }
]

文本内容:
${state.input}`
      }
    ]);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error?.message || `API请求失败: ${response.status}`);
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content || '';
    
    if (!resultText) {
      throw new Error('API返回内容为空');
    }
    
    const cleanText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      const parsedPhrases = JSON.parse(cleanText);
      state.phrases = parsedPhrases;
      
      // 保存到短文簿
      if (parsedPhrases.length > 0) {
        await saveToArticles(state.input, parsedPhrases);
      }
    } catch (e) {
      console.error('JSON解析错误:', e);
      console.error('原始返回:', resultText);
      state.error = '解析结果失败,请重试。返回内容: ' + resultText.substring(0, 200);
    }

  } catch (err) {
    state.error = '处理失败: ' + (err.message || '未知错误');
    console.error('提取短语错误:', err);
  } finally {
    state.loading = false;
    render();
  }
}

// 显示成功提示
function showSuccessToast(message) {
  state.toastMessage = message;
  state.showToast = true;
  render();
  setTimeout(() => {
    state.showToast = false;
    render();
  }, 2000);
}

// 复制所有短语
async function copyAllPhrases() {
  let text = '📖 原文内容\n';
  text += '═══════════════════════════════════════\n\n';
  text += state.input + '\n\n';
  text += '📝 提取的短语 (共 ' + state.phrases.length + ' 个)\n';
  text += '═══════════════════════════════════════\n\n';
  
  state.phrases.forEach((item, index) => {
    text += `【${index + 1}】 ${item.phrase} \n`;
    if (item.phonetic) {
      text += `    音标: ${item.phonetic}\n`;
    }
    text += `    释义: ${item.meaning}\n`;
    text += `    文中例句: ${item.contextExample || '暂无'}\n`;
    if (item.otherExamples && item.otherExamples.length > 0) {
      text += `    其他例句:\n`;
      item.otherExamples.forEach((ex, i) => {
        text += `      ${i + 1}) ${ex}\n`;
      });
    }
    text += '\n';
  });
  
  try {
    await navigator.clipboard.writeText(text);
    state.copied = true;
    render();
    setTimeout(() => {
      state.copied = false;
      render();
    }, 2000);
    showSuccessToast('复制成功!');
  } catch (err) {
    console.error('复制失败:', err);
    alert('复制失败，请手动选择文本复制');
  }
}

// 导出为Markdown
function exportToMarkdown() {
  try {
    let markdown = '# 英语短语学习笔记\n\n';
    markdown += `>  导出时间: ${new Date().toLocaleString('zh-CN')}\n`;
    markdown += `>  共提取 ${state.phrases.length} 个短语\n\n`;
    
    // 添加原文
    markdown += '### 📖 原文\n\n';
    markdown += '```\n';
    markdown += state.input + '\n';
    markdown += '```\n\n';
    markdown += '\n\n';

    // 添加短语列表    
    state.phrases.forEach((item, index) => {
      markdown += `## ${index + 1}. **${item.phrase}**\n\n`;
      if (item.phonetic) {
        markdown += `🔊 ${item.phonetic}\n\n`;
      }
      markdown += `### ${item.meaning}\n\n`;
      markdown += `**文中例句:**\n`;
      markdown += `> ${item.contextExample || '暂无'}\n\n`;
      markdown += `**其他场景:**\n\n`;
      if (item.otherExamples && item.otherExamples.length > 0) {
        item.otherExamples.forEach((ex, i) => {
          markdown += `${i + 1}. ${ex}\n`;
        });
      } else {
        markdown += `暂无\n`;
      }
      markdown += '\n\n\n';
    });
    
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `英语短语_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSuccessToast('导出Markdown成功!');
  } catch (err) {
    console.error('导出失败:', err);
    alert('导出失败，请重试');
  }
}

// 渲染UI
function render() {
  const app = document.getElementById('app');
  
  app.innerHTML = `
    ${state.showToast ? `
      <div class="toast animate-fade-in">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span style="font-weight: 600; font-size: 0.875rem;">${escapeHtml(state.toastMessage)}</span>
      </div>
    ` : ''}
    
    <div class="container">
      <div class="card">
        <div class="flex items-center justify-between mb-4">
          <h1 id="titleBtn" class="title" style="cursor: pointer;">短语工具</h1>
          <div class="flex" style="gap: 0;">
            <button id="homeBtn" class="btn" style="font-size: 0.875rem; padding: 0.4rem; background: transparent; border: none;">
              <img src="home.png" width="18" height="18" alt="首页" style="display: block;" />
            </button>
            <button id="vocabularyBtn" class="btn" style="font-size: 0.875rem; padding: 0.4rem; background: transparent; border: none;">
              <img src="单词库.png" width="18" height="18" alt="单词本" style="display: block;" />
            </button>
            <button id="articlesBtn" class="btn" style="display: none;">
              <img src="短文.png" width="18" height="18" alt="短文簿" style="display: none;" />
            </button>
            <button id="translateHistoryBtn" class="btn" style="font-size: 0.875rem; padding: 0.4rem; background: transparent; border: none;" title="翻译记录">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1f2937" stroke-width="2" style="display: block;">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10"/>
                <polyline points="12 6 12 12 16 14"/>
                <polyline points="22 2 22 8 16 8"/>
              </svg>
            </button>
            <button id="apiSettingsBtn" class="btn" style="font-size: 0.875rem; padding: 0.4rem; background: transparent; border: none;" title="API设置">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${state.apiKey ? '#1f2937' : '#dc2626'}" stroke-width="2" style="display: block;">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.35 1.05V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.05-.35H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .35-1.05V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.32.38.58.6 1 .24.42.62.65 1.05.65H21a2 2 0 1 1 0 4h-.09c-.43 0-.81.23-1.05.65-.22.42-.46.68-.6 1Z"></path>
              </svg>
            </button>
          </div>
        </div>

        ${state.showApiSettings || !state.apiKey ? `
          <div class="api-settings mb-4">
            <div class="flex items-center justify-between mb-2">
              <div>
                <p style="font-weight: 600; color: #1f2937; font-size: 0.875rem;">DashScope API Key</p>
                <p style="font-size: 0.75rem; color: #6b7280; margin-top: 0.125rem;">密钥只保存在本机 Chrome 存储中，不会提交到代码仓库。</p>
              </div>
              ${state.apiKey ? `<span class="api-status">已配置</span>` : `<span class="api-status api-status-missing">未配置</span>`}
            </div>
            <input
              type="password"
              id="apiKeyInput"
              placeholder="请输入你的 DashScope API Key"
              value="${escapeAttr(state.apiKeyInput)}"
              class="word-input"
              autocomplete="off"
            />
            <div class="flex gap-2 mt-2">
              <button id="saveApiKeyBtn" class="btn btn-primary" style="flex: 1; justify-content: center;">保存</button>
              ${state.apiKey ? `<button id="clearApiKeyBtn" class="btn btn-gray" style="flex: 1; justify-content: center;">清除</button>` : ''}
            </div>
          </div>
        ` : ''}
        
        ${(state.mode === 'extract' || state.mode === 'generate' || state.mode === 'translate') && !(state.mode === 'translate' && state.translateReady) ? `
        <!-- 模式切换 -->
        <div class="flex gap-2 mb-4">
          <button id="generateModeBtn" class="btn ${state.mode === 'generate' ? 'btn-primary' : 'btn-gray'}" style="flex: 1; font-size: 0.85rem; padding: 0.362rem 0.57em; display: flex; align-items: center; justify-content: center;">
            生成
          </button>
          <button id="extractModeBtn" class="btn ${state.mode === 'extract' ? 'btn-primary' : 'btn-gray'}" style="display: none;">
            提取
          </button>
          <button id="translateModeBtn" class="btn ${state.mode === 'translate' ? 'btn-primary' : 'btn-gray'}" style="flex: 1; font-size: 0.85rem; padding: 0.362rem 0.57em; display: flex; align-items: center; justify-content: center;">
            翻译
          </button>
        </div>
        ` : ''}
        
        <p class="subtitle">${
          state.mode === 'extract' ? '提取四级以上英语短语' : 
          state.mode === 'generate' ? '输入单词生成相关短语' :
          state.mode === 'translate' ? '沉浸式英文阅读' :
          state.mode === 'translateHistory' ? '翻译记录 (' + state.translateRecords.length + ' 条)' :
          state.mode === 'vocabulary' ? '单词本 (' + state.vocabulary.length + ' 个短语)' :
          state.mode === 'review' ? '今日复习 (' + state.reviewWords.length + ' 个短语)' :
          '短文簿 (' + state.articles.length + ' 篇文章)'
        }</p>

        ${state.mode === 'translateHistory' ? `
          <!-- 翻译记录模式 -->
          ${state.translateRecords.length > 0 ? `
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              ${state.translateRecords.map(record => `
                <div class="phrase-card view-translate-record-btn" data-record-id="${record.id}" style="cursor: pointer;">
                  <div class="flex items-center justify-between">
                    <div style="flex: 1;">
                      <p style="font-weight: 600; color: #1f2937; font-size: 0.875rem; margin-bottom: 0.25rem;">📖 ${escapeHtml(record.title)}</p>
                      <p style="font-size: 0.75rem; color: #6b7280;">${escapeHtml(record.date)} · ${Object.keys(record.wordMap || {}).length} 词 · ${(record.newWords || []).length} 生词</p>
                    </div>
                    <div class="flex items-center gap-1">
                      <button class="btn btn-red delete-translate-record-btn" data-record-id="${record.id}" style="padding: 0.25rem 0.375rem; font-size: 0.75rem;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #9ca3af;">
                        <polyline points="9 18 15 12 9 6"></polyline>
                      </svg>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div style="text-align: center; padding: 3rem 1rem; color: #9ca3af;">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin: 0 auto 1rem;">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10"/>
                <polyline points="12 6 12 12 16 14"/>
                <polyline points="22 2 22 8 16 8"/>
              </svg>
              <p style="font-size: 0.875rem;">还没有翻译记录</p>
              <p style="font-size: 0.75rem; margin-top: 0.5rem;">使用翻译功能后会自动保存记录</p>
            </div>
          `}
        ` : ''}

        ${state.mode === 'articles' ? `
          <!-- 短文簿模式 -->
          ${state.selectedArticle ? `
            <!-- 文章详情 -->
            <div class="mb-3">
              <button id="backToArticlesBtn" class="btn btn-gray" style="padding: 0.375rem 0.75rem;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="19" y1="12" x2="5" y2="12"></line>
                  <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
                返回列表
              </button>
            </div>
            
            <div style="background: #f9fafb; padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem;">
              <div class="flex items-center justify-between mb-2">
                <h3 style="font-weight: bold; color: #1f2937;">📄 ${escapeHtml(state.selectedArticle.title)}</h3>
                <button class="btn btn-red delete-article-btn" data-article-id="${escapeAttr(state.selectedArticle.id)}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                  删除
                </button>
              </div>
              <p style="font-size: 0.75rem; color: #6b7280; margin-bottom: 0.5rem;">${escapeHtml(state.selectedArticle.date)} · ${state.selectedArticle.phraseCount} 个短语</p>
              <div style="background: white; padding: 0.75rem; border-radius: 0.375rem; max-height: 200px; overflow-y: auto; font-size: 0.875rem; line-height: 1.6; color: #374151; white-space: pre-wrap;">${escapeHtml(state.selectedArticle.content)}</div>
            </div>
            
            <h3 style="font-weight: bold; margin-bottom: 0.75rem; color: #1f2937;">提取的短语</h3>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              ${state.selectedArticle.phrases.map((item, index) => `
                <div class="phrase-card">
                  <div class="flex items-start gap-2">
                    <span class="phrase-number">${index + 1}</span>
                    <div style="flex: 1;">
                      <p class="phrase-title">${escapeHtml(item.phrase)}</p>
                      ${item.phonetic ? `<p class="phrase-phonetic">${escapeHtml(item.phonetic)}</p>` : ''}
                      <p class="phrase-meaning">${escapeHtml(item.meaning)}</p>
                      ${item.contextExample ? `
                        <div class="phrase-example">
                          <p class="phrase-example-label">文中例句:</p>
                          <p class="phrase-example-text">${escapeHtml(item.contextExample)}</p>
                        </div>
                      ` : ''}
                      ${item.otherExamples && item.otherExamples.length > 0 ? `
                        <div class="phrase-other-examples">
                          <p class="phrase-other-examples-label">其他例句:</p>
                          ${item.otherExamples.map(ex => `
                            <p class="phrase-other-example-item">• ${escapeHtml(ex)}</p>
                          `).join('')}
                        </div>
                      ` : ''}
                    </div>
                    <button class="btn btn-green add-to-vocab-btn" data-phrase="${escapeAttr(item.phrase)}" data-meaning="${escapeAttr(item.meaning)}" data-phonetic="${escapeAttr(item.phonetic || '')}" data-examples="${escapeJsonAttr([item.contextExample || '', ...(item.otherExamples || [])].filter(ex => ex).slice(0, 2))}" style="padding: 0.375rem; margin-left: 0.5rem; white-space: nowrap; align-self: flex-start;">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <!-- 文章列表 -->
            ${state.articles.length > 0 ? `
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${state.articles.map(article => `
                  <div class="phrase-card view-article-btn" data-article-id="${escapeAttr(article.id)}" style="cursor: pointer;">
                    <div class="flex items-center justify-between">
                      <div style="flex: 1;">
                        <p style="font-weight: 600; color: #1f2937; font-size: 0.875rem; margin-bottom: 0.25rem;">📄 ${escapeHtml(article.title)}</p>
                        <p style="font-size: 0.75rem; color: #6b7280;">${escapeHtml(article.date)} · ${article.phraseCount} 个短语</p>
                      </div>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #9ca3af;">
                        <polyline points="9 18 15 12 9 6"></polyline>
                      </svg>
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div style="text-align: center; padding: 3rem 1rem; color: #9ca3af;">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin: 0 auto 1rem;">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                </svg>
                <p style="font-size: 0.875rem;">短文簿还是空的</p>
                <p style="font-size: 0.75rem; margin-top: 0.5rem;">提取短语后会自动保存文章</p>
              </div>
            `}
          `}
        ` : ''}

        ${state.mode === 'extract' ? `
        <!-- 提取模式 -->
        <textarea
          id="inputText"
          placeholder="请粘贴英文文章内容..."
        >${escapeHtml(state.input)}</textarea>

        <button
          id="extractBtn"
          ${state.loading ? 'disabled' : ''}
          class="btn btn-primary btn-full"
        >
          ${state.loading ? `
            <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
            正在提取...
          ` : '提取短语'}
        </button>
        ` : ''}
        
        ${state.mode === 'generate' ? `
        <!-- 生成模式 -->
        <input
          type="text"
          id="wordInput"
          placeholder="请输入一个英文单词，如：advantage"
          value="${escapeAttr(state.input)}"
          class="word-input"
        />

        <button
          id="generateBtn"
          ${state.loading ? 'disabled' : ''}
          class="btn btn-primary btn-full"
        >
          ${state.loading ? `
            <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
            正在生成...
          ` : '生成短语'}
        </button>
        ` : ''}

        ${state.mode === 'translate' ? `
        <!-- 翻译/沉浸式阅读模式 -->
        ${!state.translateReady ? `
          <!-- 输入阶段 -->
          <div class="mb-3">
            <label id="translateFileLabel" class="translate-file-label">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              上传文件 (.txt / .md)
              <input type="file" id="translateFileInput" accept=".txt,.text,.md,.markdown" style="display: none;" />
            </label>
          </div>
          <textarea
            id="translateTextInput"
            placeholder="粘贴英文短文到这里，或上传文件..."
            style="height: 12rem;"
          >${escapeHtml(state.translateInput)}</textarea>

          <button
            id="translateBtn"
            ${state.loading ? 'disabled' : ''}
            class="btn btn-primary btn-full"
          >
            ${state.loading ? `
              <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              </svg>
              正在提取短语...
            ` : `
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20V10M18 20V4M6 20v-4"/>
              </svg>
              开始沉浸式阅读
            `}
          </button>
        ` : `
          <!-- 沉浸式阅读界面 -->
          <div class="flex items-center justify-between mb-3">
            <button id="translateBackBtn" class="btn btn-gray" style="padding: 0.375rem 0.75rem;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              返回
            </button>
            <button id="exportTranslateBtn" class="btn btn-indigo" style="display: none;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              导出
            </button>
          </div>
          
          <div class="immersive-reading-area" id="immersiveReadingArea">
            ${buildImmersiveHTML(state.translateOriginalText)}
          </div>

          <!-- 悬浮释义tooltip（由JS动态定位） -->
          <div id="wordTooltip" class="word-tooltip" style="display: none;">
            <span class="word-tooltip-phonetic"></span>
            <span class="word-tooltip-pos"></span>
            <span class="word-tooltip-meaning"></span>
          </div>

          <!-- 生词区 -->
          <div class="new-words-section mt-4">
            <div class="flex items-center justify-between mb-2">
              <h3 style="font-weight: bold; font-size: 0.9375rem; color: #1f2937;">
                📝 生词区 ${state.newWords.length > 0 ? '(' + state.newWords.length + ')' : ''}
              </h3>
              <span style="font-size: 0.75rem; color: #9ca3af;">双击文中短语添加</span>
            </div>
            
            ${state.newWords.length > 0 ? `
              <div class="new-words-list">
                ${state.newWords.map(w => {
                  const isGenerated = state.newWordPhraseGenerated.has(w.word);
                  return `
                    <div class="new-word-tag ${isGenerated ? 'new-word-tag-generated' : ''}" data-word="${escapeAttr(w.word)}">
                      <span class="new-word-tag-word">${escapeHtml(w.word)}</span>
                      ${w.phonetic ? `<span class="new-word-tag-phonetic">${escapeHtml(w.phonetic)}</span>` : ''}
                      <span class="new-word-tag-pos">${escapeHtml(w.pos)}</span>
                      <span class="new-word-tag-meaning">${escapeHtml(w.meaning)}</span>
                      <button class="new-word-remove-btn" data-word="${escapeAttr(w.word)}">&times;</button>
                    </div>
                  `;
                }).join('')}
              </div>

              <button
                id="generateNewWordPhrasesBtn"
                ${state.generatingNewWordPhrases ? 'disabled' : ''}
                class="btn btn-primary btn-full"
                style="margin-top: 0.75rem;"
              >
                ${state.generatingNewWordPhrases ? `
                  <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                  </svg>
                  正在生成例句...
                ` : `生成例句`}
              </button>

              <!-- 已生成的例句列表 -->
              ${Object.keys(state.newWordPhrases).length > 0 ? `
                <div class="mt-3" style="display: flex; flex-direction: column; gap: 0.75rem;">
                  ${state.newWords.filter(w => state.newWordPhrases[w.word]).map(w => `
                    <div class="phrase-card" style="padding: 0.625rem;">
                      <div style="flex: 1;">
                        <p class="phrase-title" style="font-size: 0.875rem;">${escapeHtml(w.word)}</p>
                        ${w.phonetic ? `<p class="phrase-phonetic">${escapeHtml(w.phonetic)}</p>` : ''}
                        <p class="phrase-meaning" style="font-size: 0.8125rem;">${escapeHtml(w.pos)} ${escapeHtml(w.meaning)}</p>
                        ${Array.isArray(state.newWordPhrases[w.word]) && state.newWordPhrases[w.word].length > 0 ? `
                          <div class="phrase-other-examples" style="margin-top: 0.25rem;">
                            ${state.newWordPhrases[w.word].map(ex => typeof ex === 'string' ? `
                              <p class="phrase-other-example-item" style="font-size: 0.8125rem;">• ${escapeHtml(ex)}</p>
                            ` : `
                              <p class="phrase-other-example-item" style="font-size: 0.8125rem;">• ${escapeHtml(ex.en)}</p>
                              <p style="font-size: 0.75rem; color: #6b7280; margin: 0.1rem 0 0.3rem 1rem;">${escapeHtml(ex.zh)}</p>
                            `).join('')}
                          </div>
                        ` : ''}
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            ` : `
              <div style="text-align: center; padding: 1.5rem 1rem; color: #9ca3af; background: #f9fafb; border-radius: 0.5rem; border: 1px dashed #d1d5db;">
                <p style="font-size: 0.8125rem;">双击文章中的短语可将其添加到生词区</p>
              </div>
            `}
          </div>
        `}
        ` : ''}

        ${state.error ? `
          <div class="error">
            ${state.error}
          </div>
        ` : ''}

        ${state.mode === 'vocabulary' ? `
          <!-- 单词本模式 -->
          ${state.vocabulary.length > 0 ? `
            <div class="mt-3">
              <!-- 日期筛选器和导出按钮 -->
              <div style="margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <div style="position: relative;">
                    <button id="vocabDatePickerBtn" class="btn btn-gray" style="padding: 0.375rem 0.625rem; font-size: 0.8125rem; display: flex; align-items: center; gap: 0.375rem; height: 30px;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="16" y1="2" x2="16" y2="6"></line>
                        <line x1="8" y1="2" x2="8" y2="6"></line>
                        <line x1="3" y1="10" x2="21" y2="10"></line>
                      </svg>
                      <span>${state.selectedVocabDate === 'all' ? '全部' : escapeHtml(state.selectedVocabDate)}</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </button>
                    
                    ${state.showVocabDatePicker ? `
                      <div style="position: absolute; top: 100%; left: 0; margin-top: 0.25rem; background: white; border: 1px solid #d1d5db; border-radius: 0.5rem; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); z-index: 10; min-width: 200px; max-height: 300px; overflow-y: auto;">
                        <div class="vocab-date-option" data-date="all" style="padding: 0.5rem 0.875rem; cursor: pointer; font-size: 0.8125rem; border-bottom: 1px solid #f3f4f6; background: ${state.selectedVocabDate === 'all' ? '#f1f8e9' : 'white'}; display: flex; align-items: center; justify-content: space-between;">
                          <div style="font-weight: 600;">全部</div>
                          <div style="font-size: 0.6875rem; color: #6b7280;">${state.vocabulary.length} 个</div>
                        </div>
                        ${getVocabularyDates().map(date => {
                          const count = state.vocabulary.filter(item => item.addedDate && item.addedDate.split(' ')[0] === date).length;
                          return `
                            <div class="vocab-date-option" data-date="${escapeAttr(date)}" style="padding: 0.5rem 0.875rem; cursor: pointer; font-size: 0.8125rem; border-bottom: 1px solid #f3f4f6; background: ${state.selectedVocabDate === date ? '#f1f8e9' : 'white'}; display: flex; align-items: center; justify-content: space-between;">
                              <div style="font-weight: 600;">${escapeHtml(date)}</div>
                              <div style="font-size: 0.6875rem; color: #6b7280;">${count} 个</div>
                            </div>
                          `;
                        }).join('')}
                      </div>
                    ` : ''}
                  </div>
                  
                  <button id="reviewBtn" class="btn btn-gray" style="height: 30px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                    </svg>
                    今日复习 ${getTodayReviewWords().length > 0 ? `(${getTodayReviewWords().length})` : ''}
                  </button>
                </div>
                
                <button id="exportVocabBtn" class="btn btn-indigo">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  导出
                </button>
              </div>
              
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${getFilteredVocabulary().map((item, index) => {
                  return `
                  <div class="phrase-card">
                    <div class="flex items-start gap-2">
                      <span class="phrase-number">${index + 1}</span>
                      <div style="flex: 1;">
                        <p class="phrase-title">${escapeHtml(item.phrase)}</p>
                        ${item.phonetic ? `<p class="phrase-phonetic">${escapeHtml(item.phonetic)}</p>` : ''}
                        <p class="phrase-meaning">${escapeHtml(item.meaning)}</p>
                        ${item.examples && item.examples.length > 0 ? `
                          <div class="phrase-other-examples">
                            <p class="phrase-other-examples-label">例句:</p>
                            ${item.examples.map(ex => typeof ex === 'string' ? `
                              <p class="phrase-other-example-item">• ${escapeHtml(ex)}</p>
                            ` : `
                              <p class="phrase-other-example-item">• ${escapeHtml(ex.en)}</p>
                              <p style="font-size: 0.75rem; color: #6b7280; margin: 0.1rem 0 0.3rem 1rem;">${escapeHtml(ex.zh)}</p>
                            `).join('')}
                          </div>
                        ` : ''}
                        <!-- 复习进度圆点 -->
                        <div style="display: flex; gap: 0.375rem; margin-top: 0.5rem; align-items: center;">
                          ${item.reviewStatus.map((review, idx) => {
                            let color = '#e5e7eb'; // 默认灰色（未完成）
                            let fill = 'none'; // 空心
                            let statusText = '';
                            let dateStr = '';
                            
                            const addedDate = new Date(item.timestamp);
                            
                            if (review.completed) {
                              // 已完成：显示实际复习的日期
                              const actualDate = new Date(review.completedDate);
                              dateStr = actualDate.toLocaleDateString('zh-CN');
                              
                              if (idx === 0) {
                                color = '#ef4444'; // 第一个红色（已学习）
                                fill = '#ef4444';
                                statusText = '已学习';
                              } else {
                                color = '#ef4444'; // 其他红色（已复习）
                                fill = '#ef4444';
                                statusText = '已复习';
                              }
                            } else {
                              // 未完成：显示计划复习日期（考虑顺延）
                              if (idx === 0) {
                                // 第一个点（添加时）
                                dateStr = addedDate.toLocaleDateString('zh-CN');
                                statusText = '待学习';
                              } else {
                                // 使用review.day（已经在loadVocabulary中更新过了）
                                // 使用自然日计算，与getDaysSinceAdded保持一致
                                const addedDay = new Date(addedDate.getFullYear(), addedDate.getMonth(), addedDate.getDate());
                                const plannedDate = new Date(addedDay.getTime() + review.day * 24 * 60 * 60 * 1000);
                                dateStr = plannedDate.toLocaleDateString('zh-CN');
                                statusText = '待复习';
                              }
                            }
                            
                            return '<div style="position: relative; display: inline-block;">' +
                              '<svg width="10" height="10" viewBox="0 0 10 10" style="cursor: pointer;" class="review-dot">' +
                              '<circle cx="5" cy="5" r="4" stroke="' + color + '" stroke-width="1.5" fill="' + fill + '" />' +
                              '</svg>' +
                              '<div class="review-tooltip" style="position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 0.25rem; background: rgba(0, 0, 0, 0.85); color: white; padding: 0.375rem 0.5rem; border-radius: 0.25rem; font-size: 0.6875rem; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 100;">' +
                              dateStr + '<br/>' + statusText +
                              '</div>' +
                              '</div>';
                          }).join('')}
                        </div>
                      </div>
                      <button class="btn btn-red remove-vocab-btn" data-vocab-id="${escapeAttr(item.id)}" style="padding: 0.25rem; margin-left: 0.5rem;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                `;
                }).join('')}
              </div>
            </div>
          ` : `
            <div style="text-align: center; padding: 3rem 1rem; color: #9ca3af;">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin: 0 auto 1rem;">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
              </svg>
              <p style="font-size: 0.875rem;">单词本还是空的</p>
              <p style="font-size: 0.75rem; margin-top: 0.5rem;">在提取或生成短语后，点击"添加到单词本"按钮收录短语</p>
            </div>
          `}
        ` : ''}

        ${state.mode === 'review' ? `
          <!-- 复习模式 -->
          <div class="mt-3">
            <button id="backToVocabBtn" class="btn btn-gray" style="padding: 0.375rem 0.75rem; margin-bottom: 1rem;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              返回单词本
            </button>
            
            ${state.reviewWords.length > 0 ? `
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${state.reviewWords.map((item, index) => {
                  const daysSince = getDaysSinceAdded(item.timestamp);
                  const currentReview = item.reviewStatus.find((r, idx) => idx > 0 && !r.completed && daysSince >= r.day);
                  
                  return `
                  <div class="phrase-card">
                    <div class="flex items-start gap-2">
                      <span class="phrase-number">${index + 1}</span>
                      <div style="flex: 1;">
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
                          <p class="phrase-title">${escapeHtml(item.phrase)}</p>
                        </div>
                        ${item.phonetic ? `<p class="phrase-phonetic">${escapeHtml(item.phonetic)}</p>` : ''}
                        <p class="phrase-meaning">${escapeHtml(item.meaning)}</p>
                        ${item.examples && item.examples.length > 0 ? `
                          <div class="phrase-other-examples">
                            <p class="phrase-other-examples-label">例句:</p>
                            ${item.examples.map(ex => typeof ex === 'string' ? `
                              <p class="phrase-other-example-item">• ${escapeHtml(ex)}</p>
                            ` : `
                              <p class="phrase-other-example-item">• ${escapeHtml(ex.en)}</p>
                              <p style="font-size: 0.75rem; color: #6b7280; margin: 0.1rem 0 0.3rem 1rem;">${escapeHtml(ex.zh)}</p>
                            `).join('')}
                          </div>
                        ` : ''}
                        <!-- 复习进度圆点 -->
                        <div style="display: flex; gap: 0.375rem; margin-top: 0.5rem; align-items: center;">
                          ${item.reviewStatus.map((review, idx) => {
                            let color = '#e5e7eb';
                            let fill = 'none';
                            let statusText = '';
                            let dateStr = '';
                            
                            const addedDate = new Date(item.timestamp);
                            
                            if (review.completed) {
                              // 已完成：显示实际复习的日期
                              const actualDate = new Date(review.completedDate);
                              dateStr = actualDate.toLocaleDateString('zh-CN');
                              
                              if (idx === 0) {
                                color = '#ef4444';
                                fill = '#ef4444';
                                statusText = '已学习';
                              } else {
                                color = '#ef4444';
                                fill = '#ef4444';
                                statusText = '已复习';
                              }
                            } else {
                              // 未完成：显示计划复习日期（考虑顺延）
                              if (idx === 0) {
                                dateStr = addedDate.toLocaleDateString('zh-CN');
                                statusText = '待学习';
                              } else {
                                // 使用review.day（已经在loadVocabulary中更新过了）
                                const plannedDate = new Date(addedDate.getTime() + review.day * 24 * 60 * 60 * 1000);
                                dateStr = plannedDate.toLocaleDateString('zh-CN');
                                statusText = '待复习';
                              }
                            }
                            
                            return '<div style="position: relative; display: inline-block;">' +
                              '<svg width="10" height="10" viewBox="0 0 10 10" style="cursor: pointer;" class="review-dot">' +
                              '<circle cx="5" cy="5" r="4" stroke="' + color + '" stroke-width="1.5" fill="' + fill + '" />' +
                              '</svg>' +
                              '<div class="review-tooltip" style="position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 0.25rem; background: rgba(0, 0, 0, 0.85); color: white; padding: 0.375rem 0.5rem; border-radius: 0.25rem; font-size: 0.6875rem; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 100;">' +
                              dateStr + '<br/>' + statusText +
                              '</div>' +
                              '</div>';
                          }).join('')}
                        </div>
                      </div>
                      <button class="btn mark-reviewed-btn" data-vocab-id="${escapeAttr(item.id)}" style="padding: 0.375rem; margin-left: 0.5rem; background: transparent; border: none; flex-shrink: 0;">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="4" ry="4"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                `;
                }).join('')}
              </div>
            ` : `
              <div style="text-align: center; padding: 3rem 1rem; color: #9ca3af;">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin: 0 auto 1rem;">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                </svg>
                <p style="font-size: 0.875rem;">今天没有需要复习的单词</p>
                <p style="font-size: 0.75rem; margin-top: 0.5rem;">继续保持，明天再来看看吧！</p>
              </div>
            `}
          </div>
        ` : ''}

        ${state.phrases.length > 0 ? `
          <div class="mt-4">
            <div class="result-header">
              <h2 class="result-title">${state.phrases.length} 个短语</h2>
              <div class="flex gap-1">
                <button id="copyBtn" class="btn btn-green">
                  ${state.copied ? `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    已复制
                  ` : `
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    复制
                  `}
                </button>
                <button id="exportMdBtn" class="btn btn-indigo">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  MD
                </button>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              ${state.phrases.map((item, index) => `
                <div class="phrase-card">
                  <div class="flex items-start gap-2">
                    <span class="phrase-number">
                      ${index + 1}
                    </span>
                    <div style="flex: 1;">
                      <p class="phrase-title">${escapeHtml(item.phrase)}</p>
                      ${item.phonetic ? `<p class="phrase-phonetic">${escapeHtml(item.phonetic)}</p>` : ''}
                      <p class="phrase-meaning">${escapeHtml(item.meaning)}</p>
                      ${item.contextExample ? `
                        <div class="phrase-example">
                          <p class="phrase-example-label">文中例句:</p>
                          <p class="phrase-example-text">${escapeHtml(item.contextExample)}</p>
                        </div>
                      ` : ''}
                      ${item.otherExamples && item.otherExamples.length > 0 ? `
                        <div class="phrase-other-examples">
                          <p class="phrase-other-examples-label">其他例句:</p>
                          ${item.otherExamples.map(ex => `
                            <p class="phrase-other-example-item">• ${escapeHtml(ex)}</p>
                          `).join('')}
                        </div>
                      ` : ''}
                    </div>
                    <button class="btn btn-green add-to-vocab-btn" data-phrase="${escapeAttr(item.phrase)}" data-meaning="${escapeAttr(item.meaning)}" data-phonetic="${escapeAttr(item.phonetic || '')}" data-examples="${escapeJsonAttr([item.contextExample || '', ...(item.otherExamples || [])].filter(ex => ex).slice(0, 2))}" style="padding: 0.375rem; margin-left: 0.5rem; white-space: nowrap; align-self: flex-start;">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${state.mode === 'generate' && state.generatedPhrases.word ? `
          <div class="mt-4">
            <!-- 单词信息卡片 -->
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 1rem; border-radius: 0.75rem; color: white; margin-bottom: 1rem;">
              <h2 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 0.25rem;">${escapeHtml(state.generatedPhrases.word)}</h2>
              <p style="font-size: 0.875rem; font-style: italic; margin-bottom: 0.5rem;">${escapeHtml(state.generatedPhrases.phonetic)}</p>
              <p style="font-size: 1rem;">${escapeHtml(state.generatedPhrases.meaning)}</p>
            </div>
            
            <!-- 短语列表 -->
            <div class="result-header">
              <h2 class="result-title">包含该单词的短语 (${state.generatedPhrases.phrases?.length || 0}个)</h2>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              ${(state.generatedPhrases.phrases || []).map((item, index) => `
                <div class="phrase-card">
                  <div class="flex items-start gap-2">
                    <span class="phrase-number">${index + 1}</span>
                    <div style="flex: 1;">
                      <p class="phrase-title">${escapeHtml(item.phrase)}</p>
                      ${item.phonetic ? `<p class="phrase-phonetic">${escapeHtml(item.phonetic)}</p>` : ''}
                      <p class="phrase-meaning">${escapeHtml(item.meaning)}</p>
                      ${item.examples && item.examples.length > 0 ? `
                        <div class="phrase-other-examples">
                          <p class="phrase-other-examples-label">例句:</p>
                          ${item.examples.map(ex => typeof ex === 'string' ? `
                            <p class="phrase-other-example-item">• ${escapeHtml(ex)}</p>
                          ` : `
                            <p class="phrase-other-example-item">• ${escapeHtml(ex.en)}</p>
                            <p style="font-size: 0.75rem; color: #6b7280; margin: 0.1rem 0 0.3rem 1rem;">${escapeHtml(ex.zh)}</p>
                          `).join('')}
                        </div>
                      ` : ''}
                    </div>
                    <button class="btn btn-green add-to-vocab-btn" data-phrase="${escapeAttr(item.phrase)}" data-meaning="${escapeAttr(item.meaning)}" data-phonetic="${escapeAttr(item.phonetic || '')}" data-examples="${escapeJsonAttr((item.examples || []).slice(0, 2))}" style="padding: 0.375rem; margin-left: 0.5rem; white-space: nowrap; align-self: flex-start;">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  
  sanitizeRenderedHTML(app);
  // 绑定事件监听器
  attachEventListeners();
}

// 事件处理函数
function setMode(mode) {
  state.mode = mode;
  state.input = '';
  state.phrases = [];
  state.generatedPhrases = [];
  state.error = '';
  state.selectedArticle = null;
  state.selectedVocabDate = 'all'; // 重置日期筛选
  if (mode === 'review') {
    state.reviewWords = getTodayReviewWords();
  }
  if (mode === 'translate') {
    // 切回翻译模式时不重置已有数据，方便继续阅读
  } else {
    // 离开翻译模式时不清除数据，回来可以继续
  }
  render();
}

function setInputType(type) {
  state.inputType = type;
  render();
}

function updateInput(value) {
  state.input = value;
}

// 绑定事件监听器
function attachEventListeners() {
  // 标题点击回到首页
  const titleBtn = document.getElementById('titleBtn');
  if (titleBtn) {
    titleBtn.addEventListener('click', () => setMode('generate'));
  }

  const apiSettingsBtn = document.getElementById('apiSettingsBtn');
  if (apiSettingsBtn) {
    apiSettingsBtn.addEventListener('click', () => {
      state.showApiSettings = !state.showApiSettings;
      state.apiKeyInput = state.apiKey;
      state.error = '';
      render();
    });
  }

  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', (e) => {
      state.apiKeyInput = e.target.value;
    });
  }

  const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
  if (saveApiKeyBtn) {
    saveApiKeyBtn.addEventListener('click', saveApiKey);
  }

  const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');
  if (clearApiKeyBtn) {
    clearApiKeyBtn.addEventListener('click', () => {
      if (confirm('确定要清除当前API Key吗？')) {
        clearApiKey();
      }
    });
  }
  
  // 首页按钮
  const homeBtn = document.getElementById('homeBtn');
  if (homeBtn) {
    homeBtn.addEventListener('click', () => setMode('generate'));
  }
  
  // 单词本按钮
  const vocabularyBtn = document.getElementById('vocabularyBtn');
  if (vocabularyBtn) {
    vocabularyBtn.addEventListener('click', () => setMode('vocabulary'));
  }
  
  // 短文簿按钮
  const articlesBtn = document.getElementById('articlesBtn');
  if (articlesBtn) {
    articlesBtn.addEventListener('click', () => setMode('articles'));
  }
  
  // 单词本日期选择器按钮
  const vocabDatePickerBtn = document.getElementById('vocabDatePickerBtn');
  if (vocabDatePickerBtn) {
    vocabDatePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.showVocabDatePicker = !state.showVocabDatePicker;
      render();
    });
  }
  
  // 单词本日期选项
  const vocabDateOptions = document.querySelectorAll('.vocab-date-option');
  vocabDateOptions.forEach(option => {
    option.addEventListener('click', () => {
      state.selectedVocabDate = option.dataset.date;
      state.showVocabDatePicker = false;
      render();
    });
    
    // 鼠标悬停效果
    option.addEventListener('mouseenter', () => {
      if (state.selectedVocabDate !== option.dataset.date) {
        option.style.background = '#f9fafb';
      }
    });
    option.addEventListener('mouseleave', () => {
      if (state.selectedVocabDate !== option.dataset.date) {
        option.style.background = 'white';
      }
    });
  });
  
  // 点击其他地方关闭日期选择器
  if (state.showVocabDatePicker) {
    document.addEventListener('click', () => {
      state.showVocabDatePicker = false;
      render();
    }, { once: true });
  }
  
  // 复习按钮
  const reviewBtn = document.getElementById('reviewBtn');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', () => {
      state.reviewWords = getTodayReviewWords();
      state.mode = 'review';
      render();
    });
  }
  
  // 返回单词本按钮
  const backToVocabBtn = document.getElementById('backToVocabBtn');
  if (backToVocabBtn) {
    backToVocabBtn.addEventListener('click', () => {
      state.mode = 'vocabulary';
      render();
    });
  }
  
  // 标记为已复习按钮
  const markReviewedBtns = document.querySelectorAll('.mark-reviewed-btn');
  markReviewedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      markAsReviewed(btn.dataset.vocabId);
    });
  });
  
  // 翻译记录按钮（顶部导航）
  const translateHistoryBtn = document.getElementById('translateHistoryBtn');
  if (translateHistoryBtn) {
    translateHistoryBtn.addEventListener('click', () => setMode('translateHistory'));
  }
  
  // 查看翻译记录
  const viewTranslateRecordBtns = document.querySelectorAll('.view-translate-record-btn');
  viewTranslateRecordBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const recordId = btn.dataset.recordId;
      const record = state.translateRecords.find(r => r.id === recordId);
      if (record) restoreTranslateRecord(record);
    });
  });
  
  // 删除翻译记录
  const deleteTranslateRecordBtns = document.querySelectorAll('.delete-translate-record-btn');
  deleteTranslateRecordBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确定要删除这条翻译记录吗？')) {
        deleteTranslateRecord(btn.dataset.recordId);
      }
    });
  });
  
  // 导出翻译结果按钮
  const exportTranslateBtn = document.getElementById('exportTranslateBtn');
  if (exportTranslateBtn) {
    exportTranslateBtn.addEventListener('click', exportTranslateMarkdown);
  }
  
  // 返回文章列表按钮
  const backToArticlesBtn = document.getElementById('backToArticlesBtn');
  if (backToArticlesBtn) {
    backToArticlesBtn.addEventListener('click', () => {
      state.selectedArticle = null;
      render();
    });
  }
  
  // 查看文章按钮
  const viewArticleBtns = document.querySelectorAll('.view-article-btn');
  viewArticleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const articleId = btn.dataset.articleId;
      const article = state.articles.find(a => a.id === articleId);
      if (article) {
        viewArticle(article);
      }
    });
  });
  
  // 删除文章按钮
  const deleteArticleBtns = document.querySelectorAll('.delete-article-btn');
  deleteArticleBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确定要删除这篇文章吗？')) {
        deleteArticle(btn.dataset.articleId);
      }
    });
  });
  
  // 模式切换按钮
  const extractModeBtn = document.getElementById('extractModeBtn');
  if (extractModeBtn) {
    extractModeBtn.addEventListener('click', () => setMode('extract'));
  }
  
  const generateModeBtn = document.getElementById('generateModeBtn');
  if (generateModeBtn) {
    generateModeBtn.addEventListener('click', () => setMode('generate'));
  }
  
  const translateModeBtn = document.getElementById('translateModeBtn');
  if (translateModeBtn) {
    translateModeBtn.addEventListener('click', () => setMode('translate'));
  }
  
  // 翻译模式：文件上传
  const translateFileInput = document.getElementById('translateFileInput');
  if (translateFileInput) {
    translateFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleTranslateFileUpload(file);
    });
  }
  
  // 翻译模式：文本输入
  const translateTextInput = document.getElementById('translateTextInput');
  if (translateTextInput) {
    translateTextInput.addEventListener('input', (e) => {
      state.translateInput = e.target.value;
    });
  }
  
  // 翻译模式：开始按钮
  const translateBtn = document.getElementById('translateBtn');
  if (translateBtn) {
    translateBtn.addEventListener('click', () => {
      if (state.translateInput.trim()) {
        batchTranslateWords(state.translateInput.trim());
      } else {
        state.error = '请输入或上传英文文本';
        render();
      }
    });
  }
  
  // 翻译模式：返回按钮
  const translateBackBtn = document.getElementById('translateBackBtn');
  if (translateBackBtn) {
    translateBackBtn.addEventListener('click', () => {
      const fromHistory = state.translateFromHistory;
      state.translateReady = false;
      state.translateWordMap = {};
      state.translateOriginalText = '';
      state.translateInput = '';
      state.newWords = [];
      state.newWordPhrases = {};
      state.translateFromHistory = false;
      if (fromHistory) {
        state.mode = 'translateHistory';
      }
      render();
    });
  }
  
  // 沉浸式阅读区：hover tooltip + 双击添加生词
  const immersiveArea = document.getElementById('immersiveReadingArea');
  const wordTooltip = document.getElementById('wordTooltip');
  if (immersiveArea && wordTooltip) {
    // hover显示释义
    immersiveArea.addEventListener('mouseover', (e) => {
      const target = e.target.closest('.immersive-word');
      if (!target) return;
      const pos = target.dataset.pos || '';
      const phonetic = target.dataset.phonetic || '';
      const meaning = target.dataset.meaning || '';
      if (!meaning) return;
      
      wordTooltip.querySelector('.word-tooltip-phonetic').textContent = phonetic;
      wordTooltip.querySelector('.word-tooltip-pos').textContent = pos;
      wordTooltip.querySelector('.word-tooltip-meaning').textContent = meaning;
      
      const rect = target.getBoundingClientRect();
      const tooltipRect = wordTooltip.getBoundingClientRect();
      wordTooltip.style.display = 'flex';
      
      // 定位在单词上方
      let top = rect.top - 36;
      let left = rect.left + rect.width / 2;
      
      // 防止溢出顶部
      if (top < 4) top = rect.bottom + 6;
      
      wordTooltip.style.position = 'fixed';
      wordTooltip.style.top = top + 'px';
      wordTooltip.style.left = left + 'px';
      wordTooltip.style.transform = 'translateX(-50%)';
      
      target.classList.add('immersive-word-active');
    });
    
    immersiveArea.addEventListener('mouseout', (e) => {
      const target = e.target.closest('.immersive-word');
      if (!target) return;
      wordTooltip.style.display = 'none';
      target.classList.remove('immersive-word-active');
    });
    
    // 双击添加生词
    immersiveArea.addEventListener('dblclick', (e) => {
      const target = e.target.closest('.immersive-word');
      if (!target) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      const word = target.dataset.word;
      const pos = target.dataset.pos || '';
      const phonetic = target.dataset.phonetic || '';
      const meaning = target.dataset.meaning || '';
      addNewWord(word, pos, phonetic, meaning);
    });
  }
  
  // 生词区：移除按钮
  const newWordRemoveBtns = document.querySelectorAll('.new-word-remove-btn');
  newWordRemoveBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNewWord(btn.dataset.word);
    });
  });
  
  // 生词区：生成短语按钮
  const generateNewWordPhrasesBtn = document.getElementById('generateNewWordPhrasesBtn');
  if (generateNewWordPhrasesBtn) {
    generateNewWordPhrasesBtn.addEventListener('click', generateNewWordPhrases);
  }
  
  // 输入框
  const inputText = document.getElementById('inputText');
  if (inputText) {
    inputText.addEventListener('input', (e) => updateInput(e.target.value));
  }
  
  const wordInput = document.getElementById('wordInput');
  if (wordInput) {
    wordInput.addEventListener('input', (e) => updateInput(e.target.value));
  }
  
  // 提取按钮
  const extractBtn = document.getElementById('extractBtn');
  if (extractBtn) {
    extractBtn.addEventListener('click', extractPhrases);
  }
  
  // 生成按钮
  const generateBtn = document.getElementById('generateBtn');
  if (generateBtn) {
    generateBtn.addEventListener('click', generatePhrases);
  }
  
  // 复制按钮
  const copyBtn = document.getElementById('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', copyAllPhrases);
  }
  
  // 导出按钮
  const exportMdBtn = document.getElementById('exportMdBtn');
  if (exportMdBtn) {
    exportMdBtn.addEventListener('click', exportToMarkdown);
  }
  
  // 导出单词本按钮
  const exportVocabBtn = document.getElementById('exportVocabBtn');
  if (exportVocabBtn) {
    exportVocabBtn.addEventListener('click', exportVocabulary);
  }
  
  // 添加到单词本按钮
  const addToVocabBtns = document.querySelectorAll('.add-to-vocab-btn');
  addToVocabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const phrase = btn.dataset.phrase;
      const meaning = btn.dataset.meaning;
      const phonetic = btn.dataset.phonetic;
      const examplesJson = btn.dataset.examples;
      let examples = [];
      try {
        examples = examplesJson ? JSON.parse(examplesJson) : [];
      } catch (e) {
        console.error('解析例句失败:', e);
      }
      addToVocabulary(phrase, meaning, examples, phonetic);
    });
  });
  
  // 从单词本移除按钮
  const removeVocabBtns = document.querySelectorAll('.remove-vocab-btn');
  removeVocabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('确定要从单词本中删除这个短语吗？')) {
        removeFromVocabulary(btn.dataset.vocabId);
      }
    });
  });
  
  // 复习圆点悬停效果
  const reviewDots = document.querySelectorAll('.review-dot');
  reviewDots.forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      const tooltip = dot.nextElementSibling;
      if (tooltip && tooltip.classList.contains('review-tooltip')) {
        tooltip.style.opacity = '1';
      }
    });
    
    dot.addEventListener('mouseleave', (e) => {
      const tooltip = dot.nextElementSibling;
      if (tooltip && tooltip.classList.contains('review-tooltip')) {
        tooltip.style.opacity = '0';
      }
    });
  });
  
  // 历史记录项点击（已废弃，保留兼容）
  const historyContents = document.querySelectorAll('.history-item-content');
  historyContents.forEach(content => {
    content.addEventListener('click', () => {
      // 不再使用
    });
  });
  
  // 删除历史记录按钮（已废弃，保留兼容）
  const deleteHistoryBtns = document.querySelectorAll('.delete-history-btn');
  deleteHistoryBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // 不再使用
    });
  });
}

// 初始化
loadApiKey();
loadArticles();
loadVocabulary();
loadTranslateRecords();
render();
