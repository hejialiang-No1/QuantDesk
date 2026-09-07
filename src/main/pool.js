/**
 * pool.js —— 内置精选股票池
 *
 * 用途：东财排行接口（clist）在限流时不稳定，且全市场扫描会拉到大量低价垃圾股/权证。
 * 这里内置一份「主流美股 + 中概 + AI算力链 + 半导体 + ETF」清单作为默认扫描池，
 * 兼顾速度与质量。用户可在界面里自行增删。
 */
const { MARKET } = require('./datasource');

const RAW = {
  'AI算力/云': [
    ['NVDA', '英伟达'], ['AVGO', '博通'], ['AMD', 'AMD'], ['TSM', '台积电'],
    ['MSFT', '微软'], ['GOOGL', '谷歌A'], ['AMZN', '亚马逊'], ['META', 'Meta'],
    ['ORCL', '甲骨文'], ['CRM', 'Salesforce'], ['NBIS', 'Nebius'], ['CRWV', 'CoreWeave'],
    ['IREN', 'IREN'], ['CORZ', 'Core Scientific'], ['APLD', 'Applied Digital'],
    ['GLXY', 'Galaxy Digital'], ['WULF', 'TeraWulf'], ['HIVE', 'HIVE Digital'],
    ['SMCI', '超微电脑'], ['DELL', '戴尔'], ['HPE', '慧与'], ['ANET', 'Arista'],
    ['VRT', 'Vertiv'], ['OKLO', 'Oklo'], ['LEU', 'Centrus Energy'],
    ['VST', 'Vistra'], ['CEG', 'Constellation Energy'], ['NRG', 'NRG Energy'],
    ['TLN', 'Talen Energy'], ['GEV', 'GE Vernova'], ['EOSE', 'Eos Energy'],
    ['QS', 'QuantumScape'], ['MU', '美光'], ['ARM', 'ARM'], ['MRVL', 'Marvell'],
    ['SNDK', 'SanDisk'], ['STX', '希捷'], ['WDC', '西部数据'],
  ],
  '半导体': [
    ['INTC', '英特尔'], ['QCOM', '高通'], ['TXN', '德州仪器'], ['AMAT', '应用材料'],
    ['LRCX', '泛林', 105], ['KLAC', '科磊'], ['ASML', '阿斯麦'], ['NXPI', '恩智浦'],
    ['ON', '安森美'], ['MCHP', '微芯'], ['ADI', '亚德诺'], ['TER', '泰瑞达'],
    ['ENTG', 'Entegris'], ['WDC', '西部数据'], ['RMBS', 'Rambus'],
    ['CRDO', 'Credo'], ['ALAB', 'Astera Labs'], ['MRAM', 'Everspin'],
  ],
  '科技巨头': [
    ['AAPL', '苹果'], ['NFLX', '奈飞'], ['TSLA', '特斯拉'], ['UBER', '优步'],
    ['ABNB', 'Airbnb'], ['SNOW', 'Snowflake'], ['PLTR', 'Palantir'], ['DDOG', 'Datadog'],
    ['SHOP', 'Shopify'], ['SQ', 'Block'], ['COIN', 'Coinbase'], ['HOOD', 'Robinhood'],
    ['SOFI', 'SoFi'], ['AFRM', 'Affirm'], ['RDDT', 'Reddit'], ['SPOT', 'Spotify'],
    ['ADBE', 'Adobe'], ['NOW', 'ServiceNow'], ['INTU', 'Intuit'], ['IBM', 'IBM'],
  ],
  '中概股': [
    ['BABA', '阿里巴巴'], ['PDD', '拼多多'], ['JD', '京东'], ['BIDU', '百度'],
    ['NTES', '网易'], ['TCOM', '携程'], ['NIO', '蔚来'], ['LI', '理想'],
    ['XPEV', '小鹏'], ['BEKE', '贝壳'], ['BILI', '哔哩哔哩'], ['TME', '腾讯音乐'],
    ['YMM', '满帮'], ['ZTO', '中通'], ['FUTU', '富途'], ['TIGR', '老虎证券'],
    ['IQ', '爱奇艺'], ['VIPS', '唯品会'], ['LU', '陆金所'], ['KC', '金山云'],
    ['MINIM', 'MiniMax'], ['ZS', 'Zscaler'],
  ],
  '金融/消费/医药': [
    ['BRK_B', '伯克希尔B'], ['JPM', '摩根大通'], ['V', 'Visa'], ['MA', '万事达'],
    ['BAC', '美国银行'], ['WFC', '富国银行'], ['GS', '高盛'], ['MS', '摩根士丹利'],
    ['C', '花旗'], ['AXP', '美国运通'], ['BLK', '贝莱德'], ['SCHW', '嘉信理财'],
    ['WMT', '沃尔玛'], ['COST', '好市多'], ['HD', '家得宝'], ['MCD', '麦当劳'],
    ['SBUX', '星巴克'], ['NKE', '耐克'], ['DIS', '迪士尼'], ['PG', '宝洁'],
    ['KO', '可口可乐'], ['PEP', '百事'], ['LLY', '礼来'], ['NVO', '诺和诺德'],
    ['UNH', '联合健康'], ['JNJ', '强生'], ['ABBV', '艾伯维'], ['MRK', '默沙东'],
    ['PFE', '辉瑞'], ['MRNA', 'Moderna'], ['REGN', '再生元'], ['GILD', '吉利德'],
  ],
  '指数ETF': [
    ['QQQ', '纳指100ETF'], ['SPY', '标普500ETF'], ['DIA', '道指ETF'],
    ['IWM', '罗素2000ETF'], ['SMH', '半导体ETF'], ['SOXL', '半导体3倍多'],
    ['TQQQ', '纳指3倍多'], ['ARKK', '木头姐创新ETF'], ['XLK', '科技板块ETF'],
    ['XLF', '金融板块ETF'], ['XLE', '能源板块ETF'], ['GLD', '黄金ETF'],
    ['TLT', '20年国债ETF'], ['VTI', '全市场ETF'], ['EEM', '新兴市场ETF'],
    ['KWEB', '中概互联网ETF'], ['MAGS', 'Mag7 ETF'], ['IBIT', '比特币ETF'],
  ],
};

/** 展开为 [{ secid, code, name, market, group }] */
function buildPool() {
  const out = [];
  const seen = new Set();
  for (const [group, list] of Object.entries(RAW)) {
    for (const row of list) {
      const [code, name, market] = row;
      const realCode = code.replace('_', '.'); // BRK_B → BRK.B
      const key = realCode.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: realCode,
        name,
        market: market || MARKET.NASDAQ,
        secid: `${market || MARKET.NASDAQ}.${realCode}`,
        group,
      });
    }
  }
  return out;
}

const POOL = buildPool();

module.exports = { POOL, GROUPS: Object.keys(RAW), buildPool };
