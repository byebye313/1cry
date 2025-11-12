const mongoose = require('mongoose');
const { Asset } = require('../models/Asset');

const wallets = [ /* البيانات التي قدمتها، سأضعها كما هي */ ];
// للاختصار، سأضع مثالًا صغيرًا هنا، لكن يمكنك إدراج كامل المصفوفة
const sampleWallets = [
  {
    name: 'P1094031052',
    Coins: [
      {
        name: 'USDT',
        networks: [
          { name: 'Tron TRC-20', address: 'TLN5AQLzJ3BHQ5xe5vAdKWxtULuDRDsZb5' },
          { name: 'Ethereum ERC-20', address: '0x32e437dF489be01CcdDd96649eB7E45921Aef447' },
          { name: 'BEB-20', address: '0x32e437dF489be01CcdDd96649eB7E45921Aef447' },
        ],
      },
      {
        name: 'Bitcoin',
        networks: [{ name: 'Bitcoin', address: '3Jq8x89zHcz2oSBLGJ3i3eUATUG4nTzbK6' }],
      },
      // أضف بقية العملات هنا
    ],
  },
  // أضف بقية المحافظ هنا
];

const seedAssets = async () => {
  try {
    await mongoose.connect('mongodb+srv://hass:Youzghadli%40123@cluster0.fhefpqk.mongodb.net/1cryptox', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // حذف البيانات القديمة (اختياري)
    await Asset.deleteMany({});
    console.log('Old assets deleted');

    // تحويل البيانات إلى تنسيق Asset
    const assets = [];
    for (const wallet of wallets) {
      for (const coin of wallet.Coins) {
        const existingAsset = assets.find((a) => a.symbol === coin.name.toUpperCase());
        if (existingAsset) {
          // إذا كانت العملة موجودة، أضف الشبكات الجديدة
          existingAsset.networks.push(
            ...coin.networks.map((network) => ({
              name: network.name,
              address: network.address,
              wallet_name: wallet.name,
            }))
          );
        } else {
          // إذا لم تكن موجودة، أنشئ عملة جديدة
          assets.push({
            symbol: coin.name.toUpperCase(),
            name: coin.name,
            networks: coin.networks.map((network) => ({
              name: network.name,
              address: network.address,
              wallet_name: wallet.name,
            })),
            is_deposit_enabled: true,
          });
        }
      }
    }

    // إدخال البيانات
    await Asset.insertMany(assets);
    console.log('Assets seeded successfully');

    mongoose.connection.close();
  } catch (error) {
    console.error('Error seeding assets:', error);
    mongoose.connection.close();
  }
};

seedAssets();