/* Mock data for 社媒增长 Agent 平台高保真原型 — aligned with PRD v1.4 */
window.BASEDATA = {
  runtime: { name: 'DSH', version: 'v0.1.0-rc.6', model: 'deepseek-v4' },

  skills: [
    { id: 's-crawl', name: '内容抓取' },
    { id: 's-analyze', name: '内容分析' },
    { id: 's-suggest', name: '运营建议' },
    { id: 's-bot', name: '检查机器人' },
    { id: 's-link', name: '检查关联账户' },
    { id: 's-adsync', name: '广告同步' },
    { id: 's-attr', name: '归因查询' },
    { id: 's-audit', name: '归因审计' },
    { id: 's-track', name: '网站智能打点推荐' },
    { id: 's-quality', name: '埋点质量 AI 分析' },
  ],

  flows: [
    {
      id: 'ads-attribution',
      line: 'ads',
      lineName: '广告归因分析',
      name: '广告归因分析闭环',
      panelId: 'panel-attribution',
      panelName: '广告归因 · Token业态（样板）',
      icon: '📈',
      status: 'built',
      badge: 'Token业态',
      label: '广告归因 · Token业态（样板）',
      desc: '广告账户同步 + Collect 事件接收 + 归因查询面板。第一期真实交付尖刀；PowerTokens 为 Token 业态样板客户实例。',
      skills: ['s-adsync', 's-attr', 's-audit'],
      mcps: ['Ryze MCP', 'Meta Ads'],
      workflows: ['ads-sync', 'attr-query'],
      steps: [
        { name: '广告同步', done: true, desc: 'Ryze → 自有库定时拉取' },
        { name: '事件收集', done: true, desc: 'SS-GTM / Collect Webhook 接收' },
        { name: '归因面板', done: true, desc: '素材 → 用户 → 事件下钻' },
        { name: '审计增强', done: true, desc: '最小审计与告警' },
      ],
    },
    {
      id: 'content-growth',
      line: 'content',
      lineName: '内容运营',
      name: '内容运营闭环',
      panelId: 'panel-content',
      panelName: '内容运营数据中心',
      icon: '📊',
      status: 'built',
      badge: '形态演示/二期',
      label: '内容运营（形态演示/二期）',
      desc: '抓取 → 分析 → 建议半闭环 + 四级下钻数据中心。高保真形态演示；第一期不验收。',
      skills: ['s-crawl', 's-analyze', 's-suggest', 's-bot', 's-link'],
      mcps: ['Reddit MCP', 'X MCP', 'TikTok MCP'],
      workflows: ['content-crawl', 'content-analyze'],
      steps: [
        { name: '抓取', done: true, desc: '按调度抓取贴文/评论' },
        { name: '分析', done: true, desc: '互动真实率 / 热度' },
        { name: '建议', done: true, desc: '运营建议输出' },
        { name: '创作', done: false, desc: '规划中 · 不做完整假交互' },
        { name: '发布', done: false, desc: '规划中 · 不做完整假交互' },
      ],
    },
  ],

  singleSkills: [
    {
      id: 'skill-track',
      cls: 'A',
      name: '网站智能打点推荐',
      desc: 'A 类 · 根据站点结构推荐 Collect / GTM 打点方案与清单（演示产出报告，不创建面板）',
      badge: '演示 / 第一期不验收',
    },
    {
      id: 'skill-quality',
      cls: 'B',
      name: '埋点质量 AI 分析',
      desc: 'B 类 · 审计已有埋点覆盖与质量问题，产出报告抽屉（演示，不自动建 Tab）',
      badge: '演示 / 第一期不验收',
    },
  ],

  schedules: [
    { name: '广告数据同步', flow: 'ads-attribution', flowIcon: '📈', target: 'Meta / Ryze · PowerTokens 样板', freq: '每小时', lastRun: '今天 09:00', nextRun: '今天 10:00', lastOut: '同步 128 条素材', status: '启用' },
    { name: '内容抓取·Reddit', flow: 'content-growth', flowIcon: '📊', target: 'Reddit · #AI', freq: '每日', lastRun: '昨天 22:00', nextRun: '今天 22:00', lastOut: '抓取 46 贴', status: '启用' },
    { name: '内容抓取·X', flow: 'content-growth', flowIcon: '📊', target: 'X · @newmaker_ai', freq: '每 30 分钟', lastRun: '今天 09:30', nextRun: '今天 10:00', lastOut: '抓取 12 贴', status: '启用' },
  ],

  tasks: [
    {
      id: 'T-240908-01', time: '今天 09:00', status: '成功', flowIcon: '📈', flowName: '广告归因分析闭环',
      steps: [
        { name: '广告同步', status: '成功', out: '128 条素材 / 42 条广告组' },
        { name: '归因刷新', status: '成功', out: '关联率 93.2%' },
      ],
    },
    {
      id: 'T-240908-02', time: '今天 08:30', status: '成功', flowIcon: '📊', flowName: '内容运营闭环',
      steps: [
        { name: '内容抓取', status: '成功', out: 'X 12 贴' },
        { name: '机器人检测', status: '成功', out: '疑似机器人 18%' },
        { name: '运营建议', status: '成功', out: '3 条建议' },
      ],
    },
    {
      id: 'T-240907-08', time: '昨天 22:00', status: '失败', flowIcon: '📊', flowName: '内容运营闭环',
      steps: [
        { name: '内容抓取', status: '失败', out: 'Reddit MCP 超时' },
        { name: '内容分析', status: '待执行', out: '—' },
      ],
    },
  ],

  authAccounts: [
    { icon: '📘', platform: 'Meta 广告账户', type: 'Ryze MCP 只读', owner: '投放组', scope: '广告系列/组/素材只读', status: '有效', exp: '2026-12-01', usedBy: ['广告数据同步'], section: 'ads' },
    { icon: '🔌', platform: 'Ryze MCP', type: '第三方 MCP', owner: '平台', scope: '广告拉取 API', status: '有效', exp: '2027-01-15', usedBy: ['广告数据同步'], section: 'ads' },
    { icon: '🔺', platform: 'Reddit', type: 'OAuth', owner: '运营组', scope: '读帖 / 读评论', status: '有效', exp: '2026-11-20', usedBy: ['内容抓取·Reddit'], section: 'social' },
    { icon: '𝕏', platform: 'X', type: 'OAuth', owner: '运营组', scope: '读推文 / 读互动', status: '即将过期', exp: '2026-09-20', usedBy: ['内容抓取·X'], section: 'social' },
    { icon: '🎵', platform: 'TikTok', type: 'OAuth', owner: '运营组', scope: '读视频 / 读评论', status: '有效', exp: '2026-10-30', usedBy: [], section: 'social' },
  ],

  ptKeys: [
    { name: '平台引导创建 Key', key: 'pk_live_••••••••a3f2', model: 'deepseek-v4（固定）', status: '有效', note: '对话模型账单 · 不消耗平台免费额度' },
    { name: '自带 token（高级）', key: '未配置', model: '—', status: '可选', note: '可接其他模型' },
  ],

  members: [
    { name: '张明', role: '管理员', color: '#0f3460', flows: '全部业务流 + 面板', note: '可配置业务流 / 管理授权' },
    { name: '李婷', role: '运营', color: '#10b981', flows: '内容运营数据中心', note: '可查看内容面板 · 不可改授权' },
    { name: '王强', role: '投放', color: '#3b82f6', flows: '广告归因 · Token业态（样板）', note: '可查看归因面板 · 可配调度' },
    { name: '赵静', role: '只读', color: '#8b5cf6', flows: '两个面板只读', note: '仅查看，不可启用/停用' },
  ],

  platformStats: [
    { platform: 'X', bloggers: 2, posts: 6, avgAuthenticity: '86%', topTopic: '#AI' },
    { platform: 'Instagram', bloggers: 1, posts: 3, avgAuthenticity: '78%', topTopic: '#Beauty' },
    { platform: 'TikTok', bloggers: 1, posts: 3, avgAuthenticity: '91%', topTopic: '#Fitness' },
    { platform: 'Reddit', bloggers: 1, posts: 2, avgAuthenticity: '94%', topTopic: '#SaaS' },
  ],

  hashtags: [
    { tag: '#AI', platform: 'X', posts: 42, interaction: '6.2%', trend: '+12%', hot: 3 },
    { tag: '#SaaS', platform: 'Reddit', posts: 28, interaction: '4.8%', trend: '+5%', hot: 2 },
    { tag: '#Beauty', platform: 'Instagram', posts: 35, interaction: '8.1%', trend: '-3%', hot: 2 },
    { tag: '#Fitness', platform: 'TikTok', posts: 51, interaction: '9.4%', trend: '+18%', hot: 3 },
  ],

  reportPosts: {
    newmaker_ai: {
      name: 'NewMaker', handle: '@newmaker_ai', platform: 'X', color: '#3b82f6', authenticity: 88,
      posts: [
        { date: '09-07', platform: 'X', text: '刚测完一波 Token 业态广告素材，转化漏斗里「充值」环节掉得最狠，值得拆开看。', likes: 320, comments: 28, views: 4200, score: 92, topics: ['#AI', '#SaaS'] },
        { date: '09-06', platform: 'X', text: '社媒增长 Agent 不是又一个看板，而是「启用业务流 → 面板 → 对话」一条链。', likes: 210, comments: 15, views: 3100, score: 85, topics: ['#AI'] },
        { date: '09-05', platform: 'X', text: '四级下钻比四维下钻更不容易和归因审计撞名——命名也是产品设计。', likes: 180, comments: 12, views: 2800, score: 80, topics: ['#AI'] },
      ],
    },
    beauty_lab: {
      name: 'BeautyLab', handle: '@beautylab', platform: 'Instagram', color: '#ec4899', authenticity: 78,
      posts: [
        { date: '09-07', platform: 'Instagram', text: '秋冬护肤清单：先看成分表再看广告素材，不然 CPA 会教你做人。', likes: 890, comments: 64, views: 12000, score: 88, topics: ['#Beauty'] },
        { date: '09-04', platform: 'Instagram', text: '今日妆容：大地色系 + 一点高光，评论区帮我选下一支口红？', likes: 650, comments: 90, views: 9800, score: 82, topics: ['#Beauty'] },
        { date: '09-02', platform: 'Instagram', text: '新品试色来了，真实互动率比点赞更重要。', likes: 420, comments: 33, views: 7200, score: 75, topics: ['#Beauty'] },
      ],
    },
    marcusfit: {
      name: 'MarcusFit', handle: '@marcusfit', platform: 'TikTok', color: '#10b981', authenticity: 91,
      posts: [
        { date: '09-07', platform: 'TikTok', text: '15 分钟居家力量训练，跟练完告诉我心率。', likes: 12000, comments: 430, views: 180000, score: 97, topics: ['#Fitness'] },
        { date: '09-05', platform: 'TikTok', text: '蛋白质怎么吃才不浪费？三条原则。', likes: 8600, comments: 210, views: 120000, score: 90, topics: ['#Fitness'] },
        { date: '09-03', platform: 'TikTok', text: '新手深蹲常见错误，看完少走半年弯路。', likes: 5400, comments: 160, views: 90000, score: 86, topics: ['#Fitness'] },
      ],
    },
    saas_ops: {
      name: 'SaaS Ops', handle: 'u/saas_ops', platform: 'Reddit', color: '#f59e0b', authenticity: 94,
      posts: [
        { date: '09-06', platform: 'Reddit', text: '我们把广告归因做成 Token 业态样板后，启用到首屏面板 < 10 分钟（含 SS-GTM 清单）。', likes: 140, comments: 38, views: 5200, score: 89, topics: ['#SaaS', '#AI'] },
        { date: '09-04', platform: 'Reddit', text: '单点 Skill 不该强行建空面板——报告抽屉就够了。', likes: 95, comments: 22, views: 3100, score: 84, topics: ['#SaaS'] },
      ],
    },
    ai_weekly: {
      name: 'AI Weekly', handle: '@ai_weekly', platform: 'X', color: '#8b5cf6', authenticity: 84,
      posts: [
        { date: '09-07', platform: 'X', text: '本周值得看的 5 个 Agent 产品形态：壳 + 可插拔业务线。', likes: 410, comments: 40, views: 9000, score: 91, topics: ['#AI'] },
        { date: '09-05', platform: 'X', text: '自定义定时 ≠ 业务流数据刷新，别混在一个 Tab 里讲故事。', likes: 260, comments: 19, views: 6100, score: 83, topics: ['#AI', '#SaaS'] },
        { date: '09-03', platform: 'X', text: 'PowerTokens 双重身份：被分析的客户样板 vs 对话算力 Key。', likes: 190, comments: 14, views: 4500, score: 79, topics: ['#AI'] },
      ],
    },
  },

  reportComments: [
    { name: 'alice_dev', human: true, text: '四级下钻这个命名改得好，终于不和四维审计撞了。', likes: 12 },
    { name: 'bot_farm_99', human: false, text: 'Great post!!! Follow for follow!!!', likes: 0 },
    { name: 'growth_pm', human: true, text: '开始页三卡片比硬弹窗友好多了。', likes: 8 },
    { name: 'clickbait_x', human: false, text: 'Click here to win free tokens 🎁🎁🎁', likes: 1 },
    { name: 'ops_lee', human: true, text: 'SS-GTM 双写清单放进启用向导，这才叫诚实。', likes: 15 },
  ],

  attribution: {
    kpis: [
      { val: '$12.4k', label: '广告消耗' },
      { val: '3,842', label: '点击' },
      { val: '1,026', label: '注册' },
      { val: '186', label: '充值用户' },
      { val: '$48', label: 'CPA' },
      { val: '3.2x', label: 'ROAS' },
    ],
    funnel: [
      { val: 1026, label: '注册' },
      { val: 612, label: '激活' },
      { val: 340, label: '首购意向' },
      { val: 186, label: '充值' },
    ],
    warnings: [
      { title: '素材「Token包-A」关联率偏低', level: 'warn' },
      { title: 'Collect 延迟尖刺（P95 4.8s 接近阈值）', level: 'warn' },
    ],
  },
};
