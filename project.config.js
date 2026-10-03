module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-tour-1',
      status: '已装箱',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼灵活',
        boxNo: '巡演箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-tour-2',
      status: '已装箱',
      data: {
        role: '铁扇公主',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '水袖联动',
        boxNo: '巡演箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'puppetHeads',
      id: 'head-tour-3',
      status: '已装箱',
      data: {
        role: '猪八戒',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '大耳摇动',
        boxNo: '巡演箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'accessories',
      id: 'acc-tour-1',
      status: '已装箱',
      data: { name: '金箍棒', role: '孙悟空', play: '火焰山', boxNo: '巡演箱甲-01' }
    },
    {
      collection: 'accessories',
      id: 'acc-tour-2',
      status: '已装箱',
      data: { name: '芭蕉扇', role: '铁扇公主', play: '火焰山', boxNo: '巡演箱甲-01' }
    },
    {
      collection: 'accessories',
      id: 'acc-other-1',
      status: '在库',
      data: { name: '短靠', role: '武生', play: '火焰山', boxNo: '配件箱-02' }
    },
    {
      // 旧装箱单：未给 capacity，返场清点时按原清单（3 偶头 + 2 配件 = 5）回填
      collection: 'tourBoxes',
      id: 'box-seed-tour-1',
      status: '巡演中',
      data: {
        showName: '火焰山·江南巡演',
        venue: '苏州昆曲戏台',
        play: '火焰山',
        boxNo: '巡演箱甲-01',
        headIds: ['head-tour-1', 'head-tour-2', 'head-tour-3'],
        accessoryIds: ['acc-tour-1', 'acc-tour-2'],
        headStoreBoxes: {
          'head-tour-1': '巡演箱甲-01',
          'head-tour-2': '巡演箱甲-01',
          'head-tour-3': '巡演箱甲-01'
        },
        accessoryStoreBoxes: {
          'acc-tour-1': '巡演箱甲-01',
          'acc-tour-2': '巡演箱甲-01'
        }
      },
      note: '封箱巡演，等待返场清点'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
