# 浠ｇ爜瀹℃煡鍙戠幇娓呭崟锛堥杞疄鐜帮級

> 瀵?codex 棣栬疆鐢熸垚鐨?E2EE 濯掍綋杞彂瀹炵幇鐨勫鏌ョ粨鏋溿€傝法 3 浠撳簱锛?> `im_wukong_jssdk`锛圫DK锛夈€乣TangSengDaoDaoWeb`锛圵eb锛夈€乣TangSengDaoDaoServer`锛圫erver锛夈€?> 姣忔潯鍚細浣嶇疆銆佷弗閲嶇骇銆佸鐜般€佷慨娉曘€侀獙鏀舵爣鍑嗐€備慨澶嶅悗璇峰嬀閫夊苟琛ュ搴旀祴璇曘€?>
> 缁撹锛歋DK 鏍稿績鍔犺В瀵嗕笌杞彂鎻忚堪绗﹀鐢ㄩ€昏緫鍩烘湰姝ｇ‘锛涢棶棰橀泦涓湪 **鏈嶅姟绔潈闄?娓呯悊** 涓?**Web 杞彂閿欒澶勭悊/鍚堝苟杞彂**銆?> 浼樺厛绾э細鍏堜慨 CRITICAL锛堣秺鏉?+ 鏁版嵁涓㈠け锛夛紝鍐?HIGH锛屽啀 MEDIUM/LOW銆?
---

## 宸茬‘璁ゆ棤闂锛堜笉瑕佲€滀慨鈥濆潖锛?
- SDK `toEncryptedMediaContent` 鐢?`cloneJSON` 娣辨嫹璐濓紝杞彂涓嶆薄鏌撴簮娑堟伅锛沗preparePlainMediaForwardContent` 鍙敼鍏嬮殕瀵硅薄銆?- Web `loadMediaOriginalBlob` 鏂规硶鍚嶄笌 SDK manager 鏆撮湶鐨勪竴鑷达紙宸叉牳瀹烇紝涓嶆槸鎷煎啓閿欙級銆?- **鏃?SQL 娉ㄥ叆**锛歞br 鍏ㄥ弬鏁板寲锛宍in ?` 瀵?slice 姝ｇ‘灞曞紑锛岀┖ slice 宸叉彁鍓?return銆?- MD5 鏌ヨ澶辫触闄嶇骇鍒般€岃В瀵嗛噸浼犮€嶏紙鍗曟潯杞彂璺緞锛夐€昏緫姝ｇ‘銆?
---

## CRITICAL

### [x] C1. MD5 绉掍紶鎺ュ彛瓒婃潈锛氫换鎰忕櫥褰曠敤鎴峰嚟 MD5 涓嬭浇浠栦汉鏄庢枃鏂囦欢
- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:309-327`锛坄lookupPlainFileByMD5`锛?- **闂**锛氫粎瑕佹眰鐧诲綍锛屽懡涓悗鐩存帴杩斿洖 `object_path`/`preview_path`/`content_type`/`size`锛?*鏃犳墍鏈夋潈鎴栭閬撴潈闄愭牎楠?*銆傜粨鍚堝叕寮€鏃犻壌鏉冪殑 `/v1/file/preview/*path`锛坅pi.go:122锛夛紝浠绘剰鐢ㄦ埛绠楀嚭鏌愭枃浠?MD5 鍗冲彲鎷胯矾寰勫苟涓嬭浇浠栦汉鏄庢枃鏂囦欢銆?- **澶嶇幇**锛氱敤鎴?B 鐢ㄥ凡鐭ユ枃浠剁畻 MD5 鈫?`GET /v1/file/plain/md5/<md5>` 鈫?寰?`path` 鈫?`GET /v1/file/preview/<path>` 涓嬭浇浠栦汉涓婁紶鐨勬槑鏂囥€?- **淇硶**锛氬懡涓悗涓嶅緱鐩存帴杩斿洖瀛樺偍璺緞銆傛帹鑽愪簩閫変竴锛?  1. 鍙繑鍥?`{exists: bool}`锛屽懡涓椂鐢辨湇鍔＄鍦?*鍙戦€佺洰鏍囨秷鎭椂**寤虹珛瀵硅薄寮曠敤骞剁鍙戜竴娆℃€т笅杞藉嚟璇侊紝璺緞涓嶅娉勶紱
  2. 鑻ュ繀椤昏繑鍥炲彲澶嶇敤 path锛屽垯鏍￠獙璇锋眰鑰呭璇ュ璞℃湁璁块棶鏉冿紙鍚岀鎴?鍚岄閬撴垚鍛橈級锛屽惁鍒欒涓烘湭鍛戒腑銆?- **楠屾敹**锛氭棤鏉冪敤鎴锋煡璇粬浜烘枃浠?MD5 鏃讹紝鎺ュ彛涓嶆硠闇蹭换浣曡矾寰勶紱瓒婃潈涓嬭浇琚嫆銆傝ˉ鎺ュ彛娴嬭瘯瑕嗙洊銆屽懡涓絾鏃犳潈銆嶅垎鏀€?
### [x] C2. 鍒嗙墖浼氳瘽/涓婁紶涓嶆牎楠岀洰鏍囬閬撴垚鍛樻潈闄?- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:396-431`锛坈reateE2EEChunkedUploadSession锛夈€乣api.go:433-521`
- **闂**锛氬叏绋嬪彧鏍￠獙 `session.UID == 褰撳墠鐧诲綍 UID`锛?54/473/557/581锛夛紝浠庝笉鏍￠獙鐢ㄦ埛鏄惁涓?`channel_id` 鐨勬垚鍛?鏈夊彂娑堟伅鏉冮檺銆備换鎰忕敤鎴峰彲瀵逛换鎰忛閬?id 鍒涘缓浼氳瘽骞朵笂浼犲瘑鏂囥€?- **淇硶**锛氫細璇濆垱寤轰笌鍒嗙墖涓婁紶鍓嶏紝澶嶇敤 message 妯″潡宸叉湁鐨勯閬撴垚鍛樻牎楠岋紙鍙傝€?`modules/message/api.go` 鐨?`channel.NewService(ctx)` / `GetChannelSettings`锛夛紝闈炴垚鍛樻嫆缁濄€?- **楠屾敹**锛氶潪鐩爣棰戦亾鎴愬憳鍒涘缓/涓婁紶浼氳瘽琚嫆锛涜ˉ娴嬭瘯銆?
### [x] C3. 鍚堝苟杞彂銆屽姞瀵嗏啋鏅€氥€峂D5 鏈懡涓椂鏄庢枃 Blob 涓㈠け锛屾帴鏀舵柟鏀跺埌绌烘枃浠?- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Utils/e2eeForwardReply.ts:102-119`锛坄preparePlainMediaForwardContent`锛? `packages/tsdaodaobase/src/Messages/Mergeforward/index.tsx`锛坄messageToMap`/`buildMessagePayload`锛? `Messages/File/index.tsx`銆乣Image/index.tsx` 鐨?`encodeJSON`
- **闂**锛歁D5 鏈懡涓椂瑙ｅ瘑鏄庢枃鏀捐繘 `cloned.file`(Blob)锛宍remoteUrl=""`銆備絾鍚堝苟杞彂闈?`encodeJSON()` 搴忓垪鍖栧唴宓屾秷鎭紝**鍙簭鍒楀寲 url/name/size/e2eeMedia锛屼笉鍚?file**锛屼笖鍚堝苟璺緞涓嶈Е鍙戜笂浼犱换鍔★紙`addOptimisticMessageIfNeed` 涓嶇敓鏁堬級銆傜粨鏋滃唴宓屾秷鎭?`url:""`銆佹棤 `e2eeMedia`銆丅lob 琚涪锛屾帴鏀舵柟寰楀埌鎵撲笉寮€鐨勭┖鏂囦欢锛屼笖鏃犱换浣曢敊璇彁绀恒€傚崟鏉?澶氶€夎浆鍙戣蛋 `chatManager.send` 浼氫笂浼狅紝涓嶅彈褰卞搷銆?- **淇硶**锛氬悎骞惰浆鍙戝唴宓屽獟浣撳湪搴忓垪鍖栧墠锛屽繀椤诲厛瀹屾垚涓婁紶鎷垮埌 `remoteUrl`銆傛柟妗堬細瀵瑰悎骞堕泦鍚堜腑姣忔潯銆岄渶閲嶄紶鐨勬槑鏂囧獟浣撱€嶅厛鎵ц鐪熷疄涓婁紶锛堝鐢ㄤ笂浼犱换鍔?`APIClient` 涓婁紶锛夛紝鎶婅繑鍥炵殑杩滅 path 鍐欏叆 `url/remoteUrl` 鍚庡啀 `encodeJSON`锛涙垨鍦ㄦ棤娉曚笂浼犳椂鏄庣‘鎶涢敊骞舵彁绀猴紝涓嶅緱鍙戝嚭绌哄紩鐢ㄣ€?- **楠屾敹**锛氬姞瀵嗏啋鏅€氬悎骞惰浆鍙戙€丮D5 鏈懡涓満鏅笅锛屾帴鏀舵柟鑳芥甯告墦寮€鏂囦欢锛涜ˉ涓€鏉°€屽悎骞惰浆鍙戞槑鏂囬噸浼犮€嶇鍒扮/寰€杩旀祴璇曘€?
---

## HIGH

### [x] H1. Web 杞彂閿欒琚┖ catch 鍚炴帀锛屽け璐ヤ吉瑁呮垚鎴愬姛
- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Components/Conversation/index.tsx:156-159`锛坄forwardInBatches` worker 鍐?`catch (e) {}`锛?- **闂**锛歚cloneForwardContentForChannel` 鍦?`canForwardE2EEMedia` ok:false锛坋2eeForwardReply.ts:72锛夈€佹槑鏂囪В瀵嗗け璐ワ紙:104锛夋椂鎶涢敊锛屽叏琚悶锛涜繘搴︽潯鐓ц蛋鍒般€屽畬鎴愩€嶃€傜敤鎴锋棤娉曞尯鍒嗘垚鍔?澶辫触銆?- **淇硶**锛歸orker 鎹曡幏寮傚父鍚庣疮璁″け璐ラ」锛堥閬?娑堟伅/鍘熷洜锛夛紝鍏ㄩ儴缁撴潫鏃剁敤 Toast 姹囨€绘彁绀烘垚鍔?N 鏉°€佸け璐?M 鏉″強鍘熷洜锛屼笉鍐嶉潤榛樸€?- **楠屾敹**锛氳浆鍙?ok:false 鎴栬В瀵嗗け璐ョ殑濯掍綋鏃讹紝鍑虹幇鏄庣‘澶辫触鎻愮ず锛涜ˉ娴嬭瘯銆?
### [x] H2. 鍚堝苟杞彂鍚?1 鏉′笉鍙浆鍙戝獟浣撳鑷存暣鎵归潤榛樹腑姝?- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Utils/e2eeForwardReply.ts:232-244`锛坄buildForwardableMessagesForChannel` 寰幆鍐呮棤 try/catch锛? `Components/Conversation/index.tsx:973`
- **闂**锛氬惊鐜腑浠讳竴鏉?`cloneForwardContentForChannel` 鎶涢敊鍐掓场锛岀粓姝㈣棰戦亾**鍏ㄩ儴**鍚堝苟娑堟伅鍙戦€侊紱鍙犲姞 H1 鍙樻垚銆屼粈涔堥兘娌″彂涔熸病鎻愮ず銆嶃€?- **淇硶**锛氬惊鐜唴閫愭潯 try/catch锛屽彲杞彂鐨勭収甯告敹闆嗭紝涓嶅彲杞彂鐨勮烦杩囧苟璁板綍鍘熷洜锛岀粨鏉熷悗鎻愮ず銆孨 鏉″姞瀵嗘枃浠舵棤娉曞湪褰撳墠璁惧杞彂锛屽凡璺宠繃銆嶃€?- **楠屾敹**锛氬悎骞堕泦鍚堜腑娣峰叆涓嶅彲杞彂濯掍綋鏃讹紝鍏朵綑娑堟伅姝ｅ父閫佽揪锛屼笖鏄庣‘鎻愮ず琚烦杩囬」銆?
### [x] H3. 鍒嗙墖 flush 澶辫触鍗充涪寮冨唴瀛樺厓鏁版嵁锛屼笉鍙噸璇?- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/chunk_buffer.go:44-50`锛坒lushSession锛夈€乣52-63`锛坒lushAll锛夈€乣71-73`锛坒lushLoop 鍚為敊锛?- **闂**锛氬厛鍦ㄩ攣鍐?delete/娓呯┖ map锛屽啀閿佸 `batchUpsertChunks`锛汥B 澶辫触鍒欒鎵?chunk 鍏冩暟鎹案涔呬涪澶?鈫?`completeE2EEChunkedUploadSession` 鐨?`len(chunks)!=ChunkCount` 姘镐箙澶辫触銆佸瘑鏂囧璞℃垚瀛ゅ効銆俙flushLoop` 閲?`_ = b.flushAll()` 鍚炴帀閿欒銆?- **淇硶**锛歚batchUpsertChunks` 澶辫触鏃舵妸璇ユ壒 chunk 鍥炲～ map锛堟垨鏍囪寰呴噸璇曪級锛屼笅杞?flush 鍐嶈瘯锛沠lushLoop 璁板綍閿欒鏃ュ織鑰岄潪涓㈠純銆?- **楠屾敹**锛氭ā鎷?DB flush 澶辫触涓€娆″悗鎭㈠锛屼細璇濅粛鑳?complete锛涜ˉ娴嬭瘯銆?
### [x] H4. 鏈嶅姟绔姞瀵嗗紑鍚椂 serveE2EEMediaContent 瑙ｅ瘑骞跺叕寮€杩斿洖鏄庢枃
- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:835-873`锛坄unwrapLegacyServerEncryptedE2EEMediaContent` + `serveE2EEMediaContent:868-871`锛?- **闂**锛歚Encrypt.EncryptionEnabled` 涓虹湡鏃剁敤鏈嶅姟绔?MasterKey+KeySalt 娲剧敓 fileKey 瑙ｅ瘑鏂囦欢浣擄紝骞剁粡鏃犻壌鏉?preview 绔偣杩斿洖鏄庢枃锛岃繚鍙嶃€屾湇鍔＄缁濅笉瑙ｅ瘑鏂囦欢浣撱€嶄笉鍙橀噺銆?- **寰呯‘璁?+ 淇硶**锛氱‘璁よ legacy 鍒嗘敮鍦ㄦ湰鏂伴」鐩槸鍚﹂渶瑕佸瓨鍦ㄣ€傝嫢涓嶉渶瑕侊紝鍒犻櫎璇ュ垎鏀紱鑻ラ渶瑕侊紝蹇呴』鍔犻壌鏉冧笖鏄庣‘鍏堕潪 E2EE 璇箟銆?- **楠屾敹**锛氱‘璁ょ粨璁哄苟钀藉湴锛汦2EE 瀵嗘枃涓嶇粡鏈嶅姟绔В瀵嗐€?
---

## MEDIUM

### [x] M1. E2EE鈫扙2EE 澶嶇敤澶辫触鏃堕潤榛樺洖閫€涓哄師鏍峰厠闅?- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Utils/e2eeForwardReply.ts:74-82`
- **闂**锛歚prepareReusableMediaForwardContent?.(content)` 杩斿洖 falsy锛堟柟娉曠己澶?杩斿洖 undefined锛夋椂 fall through 鍒?`cloneForwardContent(content)`锛屾妸鎸囧悜**婧愰閬?*鐨勫瘑鏂囦俊灏佸師鏍峰彂鍒扮洰鏍囧姞瀵嗛閬?鈫?鐩爣鎴愬憳鏃犳硶瑙ｅ瘑銆?- **淇硶**锛氳鍒嗘敮搴?throw typed error 骞舵彁绀猴紝涓嶅緱闄嶇骇涓哄師鏍峰厠闅嗐€?- **楠屾敹**锛氬鐢ㄤ笉鍙敤鏃剁粰鍑烘槑纭け璐ワ紝鑰岄潪鍙戝嚭涓嶅彲瑙ｅ瘑娑堟伅銆?
### [x] M2. isTargetChannelE2EE 鎷夊彇澶辫触鏃?fail-open锛屾槑鏂囧彲鑳借繘鍔犲瘑棰戦亾
- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Utils/e2eeForwardReply.ts:56-62`
- **闂**锛歚fetchChannelInfo` catch 涓?`return false`锛涚洰鏍囧疄涓哄姞瀵嗛閬撲絾淇℃伅鎷夊彇澶辫触鏃讹紝璧版槑鏂囦笂浼犺矾寰勬妸鏄庢枃浼犺繘鍔犲瘑棰戦亾銆?- **淇硶**锛歠ail-closed鈥斺€旀媺鍙栧け璐ユ椂涓嶉檷绾т负鏄庢枃锛屾敼涓烘姤閿?閲嶈瘯銆?- **楠屾敹**锛氱洰鏍囬閬撲俊鎭笉鍙緱鏃讹紝涓嶄骇鐢熸槑鏂囦笂浼犲埌鍔犲瘑棰戦亾銆?
### [x] M3. 杩囨湡娓呯悊鍙垹 DB 琛岋紝涓嶅垹 MinIO 瀵嗘枃瀵硅薄锛堝瓨鍌ㄦ硠婕忥級
- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/db_e2ee_chunked.go:88-112`锛坉eleteExpiredSessionsAndChunks锛?- **闂**锛氬彧鍒?session/chunk 鐨?DB 琛岋紝涓嶅垹闄ゅ凡涓婁紶鐨?`.e2ee` 鍒嗙墖瀵硅薄 鈫?杩囨湡/鍙栨秷浼氳瘽鐨勫瘑鏂囧璞℃案涔呮粸鐣欍€備笌鏂囨。銆孌B 涓庡璞′竴鑷存竻鐞嗐€嶄笉绗︺€?- **淇硶**锛氭竻鐞嗘椂鍏堝垹瀵硅薄鍐嶅垹璁板綍锛堟垨鍏堣鍚庡垹锛夛紝鍒犻櫎澶辫触淇濈暀璁板綍涓嬫閲嶈瘯銆?- **楠屾敹**锛氳繃鏈熸湭瀹屾垚浼氳瘽娓呯悊鍚?MinIO 涓搴斿瘑鏂囧璞′篃琚垹闄わ紱琛ユ祴璇曘€?
### [x] M4. complete 涓庡悗鍙?8-chunk flush 绔炴€侊紝鍋跺彂璇姤鈥滃垎鐗囨湭瀹屾暣鈥?- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:566-575` + `chunk_buffer.go:38-40,71`
- **闂**锛歝omplete 鐨?`flushSession` 涓?8-chunk 鑷姩 flush / flushLoop 浜ら敊鏃讹紝`queryChunks` 鍙兘璇诲埌 < ChunkCount锛屽宸蹭笂浼犲畬鎴愪細璇濊鎶ユ湭瀹屾暣銆?- **淇硶**锛歝omplete 鏃跺璇?session 鍔犻攣涓茶鍖?flush+query锛屾垨 query 鍚庡甫閲嶈瘯/绛夊緟鍦ㄩ€?flush 瀹屾垚銆?- **楠屾敹**锛氬苟鍙?flush 涓?complete 涓嶈鎶ワ紱琛ュ苟鍙戞祴璇曘€?
### [x] M5. 涓婁紶璺緞鏃?`..`/缁濆璺緞鏍￠獙
- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:762-773`锛坈heckReq锛? 鎷兼帴澶?`216-220,248-249`
- **闂**锛歚uploadPath` 鏉ヨ嚜 query锛屾湭杩囨护 `..`/鍓嶅 `/`锛屽彲璺?fileType 鍓嶇紑鏋勯€犱换鎰忓璞?key銆?- **淇硶**锛氭竻娲?path锛堟嫆缁?`..`銆佸幓鍓嶅 `/`銆侀檺瀹氬瓧绗﹂泦锛夈€?- **楠屾敹**锛氬惈 `..` 鐨勪笂浼犺矾寰勮鎷掞紱琛ユ祴璇曘€?
### [x] M6. 鍚堝苟杞彂 E2EE鈫扙2EE 澶嶇敤鍐呭 encode鈫抎ecode 寰€杩旀湭楠岃瘉
- **浣嶇疆**锛歚TangSengDaoDaoWeb/packages/tsdaodaobase/src/Messages/Mergeforward/index.tsx:71-79` + `e2eeForwardReply.ts:74-76`
- **闂**锛氬崟鏉¤浆鍙戞妸 `MessageEncryptedMedia`(reusable) 鐩存帴浜?`chatManager.send`锛涘悎骞惰浆鍙戠粡 `buildMessagePayload鈫抏ncode()` 搴忓垪鍖栬繘 payload锛屾帴鏀剁鎸?`type` 鍙嶆煡 `getMessageContent` 鍐?`decode`銆傞渶纭 reusable 鐨?`encode()` 杈撳嚭 `type` 涓庡師濯掍綋涓€鑷淬€乣decode` 鑳借繕鍘?`e2eeMedia` 淇″皝锛屽惁鍒欏悎骞跺唴宓屽姞瀵嗗獟浣撴帴鏀剁鏃犳硶瑙ｅ瘑銆傜幇鏈夋祴璇曞彧楠岃瘉瀵硅薄寮曠敤鐩哥瓑锛屾湭楠岃瘉搴忓垪鍖栧線杩斻€?- **淇硶/楠屾敹**锛氳ˉ涓€鏉?encode鈫抎ecode 寰€杩旀祴璇曪紱鑻ュ線杩斾涪澶?`e2eeMedia`锛屼慨姝?encode/decode 鎴栧悎骞惰浆鍙戝簭鍒楀寲璺緞銆?
---

## LOW

### [x] L1. 鐢熶骇浠ｇ爜娈嬬暀 console.log
- **浣嶇疆**锛歚vm.ts:1457-1463,1495-1501`銆乣Messages/File/index.tsx`銆乣Messages/ImagePreview/index.tsx`锛坄[E2EE][file-progress]` 绛夛級
- **闂**锛氳繚鍙嶉」鐩鑼冿紝涓旀硠闇叉枃浠跺悕/瀛楄妭鏁般€?- **淇硶**锛氱Щ闄ゆ垨鏀逛负鍙楀紑鍏虫帶鍒剁殑璋冭瘯鏃ュ織銆?
### [x] L2. e2eeForwardReply.ts 姝讳唬鐮?- **浣嶇疆**锛歚e2eeForwardReply.ts:153-157`锛坄applyPlainRemoteMedia` 鍐?if/else 涓ゅ垎鏀畬鍏ㄧ浉鍚岋級
- **淇硶**锛氱畝鍖栦负鐩存帴璧嬪€笺€?
### [x] L3. SDK 鏂版帴鍙ｅ叏绋?any锛屾棤 TS 澹版槑
- **浣嶇疆**锛歚e2eeForwardReply.ts` 绛夊 `canForwardE2EEMedia`/`prepareReusableMediaForwardContent`/`loadMediaOriginalBlob`/`lookupPlainFileByMD5` 鍧?`as any`
- **淇硶**锛氫负 SDK 鏂版帴鍙ｈˉ TS 绫诲瀷澹版槑锛屽幓鎺?`as any`锛岃幏寰楃紪璇戞湡淇濇姢銆?
### [x] L4. Server 鏂版祴璇曚负婧愮爜 grep 闈欐€佹柇瑷€
- **浣嶇疆**锛歚api_chunked_static_test.go`銆乣service_minio_static_test.go`銆侀儴鍒?`api_e2ee_test.go`
- **闂**锛氬涓?`strings.Contains(婧愮爜,...)`锛屼笉鎵ц handler銆佹祴涓嶅嚭 C1/C2/H3锛岃鐩栫巼铏氶珮銆?- **淇硶**锛氭敼涓哄 handler 鐨勭湡瀹炶涓烘祴璇曪紙閴存潈銆佸苟鍙戙€佸箓绛夛級銆?
### [x] L5. Server 閿欒鏃ュ織涓枃涔辩爜
- **浣嶇疆**锛歚TangSengDaoDaoServer/modules/file/api.go:857-859`
- **淇硶**锛氫慨姝ｄ负 UTF-8 涓枃銆?
### [x] L6. md5() 澧為噺鍝堝笇瀵归潪 4 鍊嶆暟 chunkSize 瀛楀榻愪細绠楅敊
- **浣嶇疆**锛歚im_wukong_jssdk/src/e2ee/e2ee_media.ts:1287-1304`
- **闂**锛氶粯璁?8MB 瀹夊叏锛涗粎褰?`chunkSize` 閰嶆垚闈?4 瀛楄妭鍊嶆暟鏃?`bytesToWordArray` 璺?chunk 瀛楀榻愰敊璇€?- **淇硶**锛氱害鏉?鏂█ chunkSize 涓?4 鐨勫€嶆暟锛屾垨鎸夌疮璁″瓧鑺傚亸绉诲仛瀛楀榻愩€?
---

## 淇椤哄簭寤鸿

1. **绗竴鎵癸紙瓒婃潈 + 鏁版嵁涓㈠け锛?*锛欳1銆丆2銆丆3銆丠1銆丠2
2. **绗簩鎵癸紙瀛樺偍/涓€鑷存€э級**锛欻3銆丮3銆丠4銆丮4
3. **绗笁鎵癸紙姝ｇ‘鎬у姞鍥猴級**锛歁1銆丮2銆丮5銆丮6
4. **绗洓鎵癸紙娓呯悊椤癸級**锛歀1鈥揕6

姣忎慨涓€鏉★細鍕鹃€夊閫夋 + 琛ュ搴旀祴璇曪紙浼樺厛鐪熷疄琛屼负娴嬭瘯锛岄伩鍏嶅啀鍫嗘簮鐮?grep 鏂█锛夈€?


