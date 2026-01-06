export interface MarketStatsCacheItem {
  symbol: string;
  name: string;
  image: string;
  price: number | null;
  high52w: number | null;
  low52w: number | null;
  volume24h: number | null;
  circulatingSupply: number | null;
  marketCap: number | null;
  lastUpdated: string;
  about: string;
}

export const PRELOADED_MARKET_STATS_CACHE: MarketStatsCacheItem[] = [
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    image:
      'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400',
    price: 92574,
    high52w: 124773.50823074432,
    low52w: 76329.090356324,
    volume24h: 36242405227,
    circulatingSupply: 19971687,
    marketCap: 1847769995233,
    lastUpdated: '2026-01-05T05:00:00.613Z',
    about:
      'Bitcoin is the world\'s first decentralized cryptocurrency, created in 2009 by the pseudonymous Satoshi Nakamoto. It enables peer-to-peer electronic cash transactions without intermediaries like banks or governments, operating on a blockchain secured by Proof of Work mining and the SHA-256 cryptographic algorithm. \r\n\r\nWith a fixed supply cap of 21 million coins and programmatic halvings every four years that reduce miner rewards, Bitcoin is designed as a deflationary digital asset often called "digital gold." Its value stems from solving the double-spending problem without trusted intermediaries, creating the first truly scarce digital asset with censorship resistance and permissionless access that no government, corporation, or individual can control.\r\n\r\nBitcoin operates as a decentralized peer-to-peer network where transactions are recorded on a public ledger called the blockchain, distributed across thousands of computers globally. Transactions are grouped into blocks added approximately every 10 minutes through mining, where specialized computers compete to solve complex mathematical puzzles. \r\n\r\nBitcoin has achieved mainstream adoption through multiple vectors. The January 2024 SEC approval of 11 spot Bitcoin ETFs opened Bitcoin investment to traditional finance participants, and corporations like Strategy (formerly MicroStrategy) are using Bitcoin as a treasury reserve asset to protect against currency debasement, offering MSTR holders amplified exposure to Bitcoin. \r\n\r\nThe Bitcoin ecosystem continues to evolve with innovations like Ordinals, which emerged in January 2023 to enable NFT-like functionality directly on Bitcoin, and BRC-20 tokens, an experimental standard for creating fungible tokens using Ordinal inscriptions. BTCFi (Bitcoin Finance) represents emerging financial applications extending beyond Bitcoin\'s traditional role, with protocols like Babylon allowing Bitcoin holders to stake BTC to secure Proof of Stake chains. ',
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    image:
      'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628',
    price: 3165.44,
    high52w: 4829.225541798332,
    low52w: 1471.3608854365523,
    volume24h: 17004389399,
    circulatingSupply: 120694851.3514547,
    marketCap: 382027517098,
    lastUpdated: '2026-01-05T05:00:00.525Z',
    about:
      "Ethereum is a global, open-source platform for decentralized applications. In other words, it is a decentralized blockchain platform that enables developers to build and deploy smart contracts and applications without central authority control. Unlike Bitcoin, which primarily functions as digital currency, Ethereum operates as a programmable global computer where developers can create any type of decentralized service. \r\n\r\nThe platform hosts over $14 billion in DeFi applications with hundreds of thousands of active users across financial protocols, NFT marketplaces, and gaming platforms. Its transition to Proof of Stake in September 2022 reduced energy consumption by over 99%, addressing environmental concerns while strengthening network security.\r\n\r\nThe network operates through thousands of independent validator nodes that process transactions and execute smart contracts on the Ethereum Virtual Machine. Smart contracts are self-executing programs written in Solidity that automatically carry out agreements when conditions are met, eliminating intermediaries like banks or brokers. \r\n\r\nValidators stake ETH as collateral to propose and validate blocks, earning rewards for honest participation while facing penalties for malicious behavior. The EIP-1559 upgrade introduced a dynamic base fee mechanism that burns ETH with each transaction, creating deflationary pressure during high network activity when more ETH is burned than issued to validators.\r\n\r\nVitalik Buterin proposed Ethereum in 2013, but seven co-founders helped build it, including Gavin Wood who created Solidity and the EVM technical specification, and Joseph Lubin who founded ConsenSys. The project launched in July 2015 after raising over $18 million through crowdfunding, quickly becoming the largest blockchain developer community. Major milestones include the 2020 Beacon Chain launch, the 2021 London hard fork implementing fee burning, and the 2022 Merge to Proof of Stake. \r\n\r\nEther (ETH) serves multiple functions: paying transaction fees (gas), staking to secure the network and earn 3-5% annual yields, serving as collateral in DeFi protocols, and purchasing NFTs and digital assets. The asset is increasingly adopted by traditional institutions, with publicly traded companies adding ETH to corporate treasuries to generate staking yields while maintaining blockchain exposure, and in 2024, the SEC approved spot Ethereum ETFs, allowing traditional investors to gain exposure through conventional brokerage accounts.\r\n\r\nEthereum's roadmap focuses on dramatically increasing transaction capacity to over 100,000 per second, reducing confirmation times, and enhancing decentralization while maintaining security against future threats like quantum computing.",
  },
  {
    symbol: 'XRP',
    name: 'XRP',
    image:
      'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png?1696501442',
    price: 2.13,
    high52w: 3.55629271011838,
    low52w: 1.791941720267648,
    volume24h: 3786123461,
    circulatingSupply: 60676393849,
    marketCap: 128980101889,
    lastUpdated: '2026-01-05T05:00:16.250Z',
    about:
      'Ripple is the catchall name for the cryptocurrency platform, the transactional protocol for which is actually XRP, in the same fashion as Ethereum is the name for the platform that facilitates trades in Ether. Like other cryptocurrencies, Ripple is built atop the idea of a distributed ledger network which requires various parties to participate in validating transactions, rather than any singular centralized authority. That facilitates transactions all over the world, and transfer fees are far cheaper than the likes of bitcoin. Unlike other cryptocurrencies, XRP transfers are effectively immediate, requiring no typical confirmation time.\r\n\r\nRipple was originally founded by a single company, Ripple Labs, and continues to be backed by it, rather than the larger network of developers that continue bitcoin’s development. It also doesn’t have a fluctuating amount of its currency in existence. Where bitcoin has a continually growing pool with an eventual maximum, and Ethereum theoretically has no limit, Ripple was created with all of its 100 billion XRP tokens right out of the gate. That number is maintained with no mining and most of the tokens are owned and held by Ripple Labs itself — around 60 billion at the latest count.\r\n\r\nEven at the recently reduced value of around half a dollar per XRP, that means Ripple Labs is currently sitting on around $20 billion worth of the cryptocurrency (note: Ripple’s price crashed hard recently, and may be worth far less than $60 billion by time you read this). It holds 55 billion XRP in an escrow account, which allows it to sell up to a billion per month if it so chooses in order to fund new projects and acquisitions. Selling such an amount would likely have a drastic effect on the cryptocurrency’s value, and isn’t something Ripple Labs plans to do anytime soon.\r\n\r\nIn actuality, Ripple Labs is looking to leverage the technology behind XRP to allow for faster banking transactions around the world. While Bitcoin and other cryptocurrencies are built on the idea of separating financial transactions from the financial organizations of traditional currencies, Ripple is almost the opposite in every sense.\r\n\r\nXRP by Ripple price can be found on this page alongside the market capitalization and additional stats.\r\n\r\n',
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    image:
      'https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756',
    price: 135.58,
    high52w: 262.5615764589647,
    low52w: 105.48654682895575,
    volume24h: 3816835119,
    circulatingSupply: 563400895.2619064,
    marketCap: 76362466154,
    lastUpdated: '2026-01-05T05:00:16.125Z',
    about:
      'Solana is a highly functional open source project that banks on blockchain technology’s permissionless nature to provide decentralized finance (DeFi) solutions. It is a layer 1 network that offers fast speeds and affordable costs. While the idea and initial work on the project began in 2017, Solana was officially launched in March 2020 by the Solana Foundation with headquarters in Geneva, Switzerland.',
  },
  {
    symbol: 'DOGE',
    name: 'Dogecoin',
    image:
      'https://coin-images.coingecko.com/coins/images/5/large/dogecoin.png?1696501409',
    price: 0.15073,
    high52w: 0.4149142593534293,
    low52w: 0.11728672656235732,
    volume24h: 2021615156,
    circulatingSupply: 168163293126.579,
    marketCap: 25333409282,
    lastUpdated: '2026-01-05T05:00:16.015Z',
    about:
      'Dogecoin is a cryptocurrency based on the popular "Doge" Internet meme and features a Shiba Inu on its logo. Dogecoin is a Litecoin fork. Introduced as a "joke currency" on 6 December 2013, Dogecoin quickly developed its own online community and reached a capitalization of US$60 million in January 2014. Compared with other cryptocurrencies, Dogecoin had a fast initial coin production schedule: 100 billion coins were in circulation by mid-2015, with an additional 5.256 billion coins every year thereafter. As of 30 June 2015, the 100 billionth Dogecoin had been mined. \r\n\r\nDogecoin was created by Billy Markus from Portland, Oregon and  Jackson Palmer from Sydney, Australia. Both wanted to create a fun cryptocurrency that will appeal beyond the core Bitcoin audience. Dogecoin is primarily used as a tipping system on Reddit and Twitter where users tip each other for creating or sharing good content. The community is very active in organising fundraising activities for deserving causes.\r\n\r\nThe developers of Dogecoin haven’t made any major changes to the coin since 2015. This means that Dogecoin could get left behind and is why Shibas are leaving Dogecoin to join more advanced platforms like Ethereum. One of Dogecoin strengths is its relaxed and fun-loving community. However, this is also a weakness because other currencies are way more professional.\r\n\r\nTo purchase Dogecoin, it involves downloading a crypto wallet, setting up a crypto exchange account and then trading away for your desired crypto currency. Once we have set up an account with a DOGE currency exchange and deposited some funds, you are ready to start trading. ',
  },
  {
    symbol: 'BCH',
    name: 'Bitcoin Cash',
    image:
      'https://coin-images.coingecko.com/coins/images/780/large/bitcoin-cash-circle.png?1696501932',
    price: 653,
    high52w: 654.6491449270181,
    low52w: 268.92150974970974,
    volume24h: 541843766,
    circulatingSupply: 19976534.27165078,
    marketCap: 13039759706,
    lastUpdated: '2026-01-05T05:00:16.060Z',
    about:
      'Bitcoin Cash is a hard fork of Bitcoin with a protocol upgrade to fix on-chain capacity. Bitcoin Cash intends to be a Bitcoin without Segregated Witness (SegWit) as soft fork, where upgrades of the protocol are done mainly through hard forks and without changing the original economic rules of the Bitcoin.\r\n\r\nBitcoin Cash (BCH) is released on 1st August 2017 as an upgraded version of the original Bitcoin Core software. The main upgrade is the increase in the block size limit from 1MB to 8MB. This effectively allows miners on the BCH chain to process up to 8 times more payments per second in comparison to Bitcoin. This makes for faster, cheaper transactions and a much smoother user experience.\r\n\r\nWhy was Bitcoin Cash Created?\r\n\r\nThe main objective of Bitcoin Cash is to to bring back the essential qualities of money inherent in the original Bitcoin software. Over the years, these qualities were filtered out of Bitcoin Core and progress was stifled by various people, organizations, and companies involved in Bitcoin protocol development. The result is that Bitcoin Core is currently unusable as money due to increasingly high fees per transactions and transfer times taking hours to complete. This is all because of the 1MB limitation of Bitcoin Core’s block size, causing it unable to accommodate to large number of transactions.\r\n\r\nEssentially Bitcoin Cash is a community-activated upgrade (otherwise known as a hard fork) of Bitcoin that increased the block size to 8MB, solving the scaling issues that plague Bitcoin Core today.\r\n\r\nNov 16th 2018: A hashwar resulted in a split between Bitcoin SV and Bitcoin ABC',
  },
  {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    image:
      'https://coin-images.coingecko.com/coins/images/11939/large/shiba.png?1696511800',
    price: 0.00000877,
    high52w: 0.000024222138688772824,
    low52w: 0.000006904497725361642,
    volume24h: 374788515,
    circulatingSupply: 589244049295023,
    marketCap: 5165430811,
    lastUpdated: '2026-01-05T05:00:17.118Z',
    about:
      "Shiba Inu (SHIB) is a meme token which began as a fun currency and has now transformed into a decentralized ecosystem. During the initial launch, 50% of the supply was allocated into Vitalik Buterin's ethereum wallet. \r\n\r\nAs a result of that, Vitalik proceeded to donate 10% of his SHIB holdings to a COVID-19 relief effort in India and the remaining 40% is burnt forever. That donation was worth about $1 billion at that time, which makes it one of the largest donation ever in the world.\r\n\r\nWhat is the Shiba Inu community working on right now? The Shiba Inu team launched a decentralized exchange called Shibaswap with 2 new tokens, LEASH and BONE. LEASH is a scarce supply token that is used to offer incentives on Shibaswap. BONE is the governance token for holders to vote on proposals on Doggy DAO.",
  },
  {
    symbol: 'POL',
    name: 'POL (ex-MATIC)',
    image:
      'https://coin-images.coingecko.com/coins/images/32440/large/pol.png?1759114181',
    price: 0.120463,
    high52w: 0.5243549355088387,
    low52w: 0.10043947440837944,
    volume24h: 67948193,
    circulatingSupply: 10568462145.79517,
    marketCap: 1273118393,
    lastUpdated: '2026-01-05T05:00:17.767Z',
    about:
      'Polygon (Previously Matic Network) is the first well-structured, easy-to-use platform for Ethereum scaling and infrastructure development. Its core component is Polygon SDK, a modular, flexible framework that supports building multiple types of applications.\r\n\r\nUsing Polygon, one can create Optimistic Rollup chains, ZK Rollup chains, stand alone chains or any other kind of infra required by the developer. \r\n\r\nPolygon effectively transforms Ethereum into a full-fledged multi-chain system (aka Internet of Blockchains). This multi-chain system is akin to other ones such as Polkadot, Cosmos, Avalanche etc with the advantages of Ethereum’s security, vibrant ecosystem and openness.\r\n\r\nNothing will change for the existing ecosystem built on the Plasma-POS chain. With Polygon, new features are being built around the existing proven technology to expand the ability to cater to diverse needs from the developer ecosystem. Polygon will continue to develop the core technology so that it can scale to a larger ecosystem. \r\n\r\nThe $MATIC token will continue to exist and will play an increasingly important role, securing the system and enabling governance.',
  },
  {
    symbol: 'APE',
    name: 'ApeCoin',
    image:
      'https://coin-images.coingecko.com/coins/images/24383/large/APECOIN.png?1756551529',
    price: 0.221887,
    high52w: 1.3579491154904824,
    low52w: 0.19543458710953832,
    volume24h: 20063844,
    circulatingSupply: 908664773,
    marketCap: 201348998,
    lastUpdated: '2026-01-05T05:00:18.113Z',
    about:
      "APE fuels culture. Backed by the best club in the world and hundreds of thousands of holders worldwide, it’s the token for digital and IRL communities, builders, creators, collectors, gamers, and beyond.\r\n\r\nAPE is the native gas token of ApeChain and is available across multiple ecosystems including Ethereum, Arbitrum, Solana and HyperLiquid.z\r\n\r\nApeCoin's mission is is to supercharge its ecosystem by supporting high-quality builders &amp; reinforcing 3 core pillars: ApeChain, Bored Ape Yacht Club, and Otherside.",
  },
  {
    symbol: 'LTC',
    name: 'Litecoin',
    image:
      'https://coin-images.coingecko.com/coins/images/2/large/litecoin.png?1696501400',
    price: 81.95,
    high52w: 136.85856621907038,
    low52w: 68.98458275503194,
    volume24h: 430936391,
    circulatingSupply: 76699770.73347135,
    marketCap: 6279200786,
    lastUpdated: '2026-01-05T05:00:16.219Z',
    about:
      "Litecoin is a peer-to-peer cryptocurrency created by Charlie Lee. It was created based on the Bitcoin protocol but differs in terms of the hashing algorithm used. Litecoin uses the memory intensive Scrypt proof of work mining algorithm. Scrypt allows consumer-grade hardware such as GPU to mine those coins.\r\n\r\nWhy Litecoin?\r\nLitecoin is a cryptocurrency that has evolved from Bitcoin after its own popularity in the industry, this alternative, or ‘altcoin’ has emerged to allow investors to diversify their digital currency package, according to Investopedia. Litecoin is one of the most prominent altcoins and was created by former Google employee and Director of Engineering at Coinbase, Charlie Lee. Litecoin was the first to alter Bitcoin and the most significant difference is that it takes 2.5 minutes for Litecoin to generate a block, or transaction, in comparison to Bitcoin's 10 minutes.\r\n\r\n‘While this matters little to traders, miners who use hardware to run Bitcoin's network cannot switch over to Litecoin. This keeps bigger mining conglomerates away from Litecoin because they cannot easily optimize their profits by swapping to another coin, contributing to a more decentralized experience. Litecoin also has bigger blocks, and more coins in circulation, making it more affordable and swift when transacting,’ Investopedia explained.\r\n\r\nAs explained above, Litecoin can transact a lot faster than Bitcoin, but there are also a number of other characteristics that investors need to know before trading. Litecoin can handle higher volumes of transactions because of the capability of transacting faster and if Bitcoin attempted to transact on the scale of its altcoin, a code update would be needed. However, Litecoin’s blocks would be larger, but with more ‘orphaned blocks'. The faster block time of litecoin reduces the risk of double spending attacks - this is theoretical in the case of both networks having the same hashing power.\r\n\r\nLitecoin Technical Details:\r\nThe transaction confirmation time taken for Litecoin is about 2.5 minutes on average (as compared to Bitcoin's 10 minutes). The Litecoin network is scheduled to cap at 84 million currency units. \r\n\r\nLitecoin has inspired many other popular alternative currencies (eg. Dogecoin) because of its Scrypt hashing algorithm in order to prevent ASIC miners from mining those coins. However it is said that by the end of this year, Scrypt ASIC will enter the mass market.",
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    image:
      'https://coin-images.coingecko.com/coins/images/7598/large/WBTCLOGO.png?1764496367',
    price: 92241,
    high52w: 124798.90772413308,
    low52w: 76228.70595363599,
    volume24h: 174534118,
    circulatingSupply: 124963.48883569,
    marketCap: 11540369470,
    lastUpdated: '2026-01-05T05:00:16.100Z',
    about:
      'WBTC is the first and largest 1:1 tokenized Bitcoin used across multiple chains, providing a consistent way to use BTC in environments that prioritize speed, efficiency, and scale while staying aligned with Bitcoin’s original principles. It operates as a trusted and verifiable asset designed for a multichain environment. WBTC’s custody model is built for security, with controlled minting and burning, 24/7 monitoring, strict access control, multi-party key handling, and regular audits to maintain high standards of security and compliance.',
  },
  {
    symbol: 'WETH',
    name: 'WETH',
    image:
      'https://coin-images.coingecko.com/coins/images/2518/large/weth.png?1696503332',
    price: 3166.14,
    high52w: 4829.058876513837,
    low52w: 1469.9284269757572,
    volume24h: 161252389,
    circulatingSupply: 2607359.135726249,
    marketCap: 8250748799,
    lastUpdated: '2026-01-05T05:00:16.513Z',
    about:
      'What is WETH (Wrapped ETH)?\r\nWETH is the tokenized/packaged form of ETH that you use to pay for items when you interact with Ethereum dApps. WETH follows the ERC-20 token standards, enabling it to achieve interoperability with other ERC-20 tokens. \r\n\r\nThis offers more utility to holders as they can use it across networks and dApps. You can stake, yield farm, lend, and provide liquidity to various liquidity pools with WETH. \r\n\r\nAlso, unlike ETH, which doesn’t conform to its own ERC-20 standard and thus has lower interoperability as it can’t be used on other chains besides Ethereum, WETH can be used on cheaper and high throughput alternatives like Binance, Polygon, Solana, and Cardano.\r\n\r\nThe price of WETH will always be the same as ETH because it maintains a 1:1 wrapping ratio.\r\n\r\nHow to Wrap ETH?\r\nCustodians wrap and unwrap ETH. To wrap ETH, you send ETH to a custodian. This can be a multi-sig wallet, a Decentralized Autonomous Organization (DAO), or a smart contract. After connecting your web3 wallet to a DeFi exchange, you enter the amount of ETH you wish to wrap and click the swap function. Once the transaction is confirmed, you will receive WETH tokens equivalent to the ETH that you’ve swapped.\r\n\r\nOn a centralized exchange, the exchange burns the deposited ETH and mints a wrapped form for you. And when you want to unwrap it, the exchange will burn the wrapped version and mint the ETH on your behalf.\r\n\r\nWhat’s Next for WETH?\r\nAccording to the developers, hopefully there will be no future for WETH. According to the website, steps are being taken to update ETH to make it compliant with its own ERC-20 standards. ',
  },
];

export const getCachedMarketStats = (currencyAbbreviation: string) => {
  const normalized = (currencyAbbreviation || '').toLowerCase();
  return PRELOADED_MARKET_STATS_CACHE.find(
    item => (item.symbol || '').toLowerCase() === normalized,
  );
};
