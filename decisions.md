# DECISIONS — OpenRouter Agentic Intelligence API

## 2026-04-12 — Incident revision scoped delegation kararı
### Problem
Dünkü two-person delegation approval modeli issuance tarafını güvenli hale getirdi, ancak delivery incident yaşam döngüsünde üç kritik açık kaldı:
1. Delegation grant'leri incident kimliğine bağlıydı ama incident revision'a bağlanmadığı için aynı incident tekrar açıldığında veya clear-request sonrası revision arttığında eski grant yeni state üzerinde yanlışlıkla kullanılabiliyordu.
2. Pending delegation request, incident ack/reopen sonrası stale kalsa bile ikinci operatör approval aşamasında aktif grant'e dönüşebiliyordu; bu da delegation approval tarafında fail-open pencere bırakıyordu.
3. Dashboard ve API görünürlüğü delegation'ın hangi incident revision için geçerli olduğunu net göstermediği için operatör stale grant ile current incident state'i ayırt etmekte zorlanıyordu.

### Seçenekler
- A: Mevcut incident-id scoped delegation modelini koruyup operatör runbook disiplini ile revision drift'i yönetmek
- B: Yalnızca consume aşamasında revision check ekleyip create/approve akışını değiştirmemek
- C: Delegation create, approve, authorize ve dashboard yüzeyini incident revision scoped hale getirip stale/missing/resolved delegation'ları fail-closed reddetmek

### Karar
**C seçildi:**
1. **Yeni özellik:** Security export operator delegation modeli artık incident revision scoped çalışıyor. `createSecurityExportOperatorDelegation(...)` çağrıları güncel `incident.revision` ile kayıt oluşturuyor ve dashboard/list API'si grant scope metadata'sını gösteriyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Delegation approval artık stale pending request'i aktive edemiyor. `getSecurityExportOperatorDelegationScope(...)` üzerinden revision drift, resolved incident, missing incident ve legacy unscoped grant durumları hesaplanıyor; current olmayan grant approval'ları `409 delegation_scope_stale` ile fail-closed reddediliyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Delegated incident aksiyonları (`acknowledge`, `clear-request`, `clear`) artık authorization sonrası `validateDelegatedSecurityExportOperatorActionScope(...)` ile current incident revision'a karşı doğrulanıyor. Revision mismatch `delegation_incident_revision_conflict`, stale/resolved state ise `delegation_scope_stale` ile kapanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Delegation lookup/create duplicate kontrolleri revision-aware hale getirildi; aynı principal aynı action için yeni incident revision'da taze delegation isteyebilirken eski revision grant'i yeni state'i bloke etmiyor.
5. **Operasyon / kalite iyileştirmesi:** Dashboard delegation tablosu ve özet alanı incident revision → current revision görünürlüğü ve scope status bilgisi kazandı; focused unit + contract testler stale approval, reopened incident, revision drift ve fresh re-delegation regresyonlarını kapsayacak şekilde genişletildi.

### Gerekçe
- Incident recovery zinciri revision temelli çalıştığı için delegation modelinin incident kimliğiyle sınırlı kalması güvenlik olarak eksikti.
- Approval aşamasında stale request'in aktive olabilmesi, two-person approval modelini incident lifecycle değişimlerine karşı zayıflatıyordu.
- Operatörün hangi grant'in current incident state'e ait olduğunu açıkça görebilmesi üretim incident yönetiminde kritik.

### Etki
- Delegation grant'leri artık incident lifecycle ile birlikte taşınan revision scope'a bağlandı.
- Reopen veya clear-request sonrası revision drift oluştuğunda eski delegation'lar yeni state üzerinde kullanılamıyor.
- Dashboard ve API yüzeyinde stale/current scope ayrımı görünür hale geldi; break-glass recovery zinciri daha güvenli ve daha anlaşılır oldu.

### Bilinçli Olarak Ertelenenler
- Delegation scope enforcement için external IdP / signed step-up attestation bağlamak
- Legacy unscoped grant'ler için otomatik migration veya arka plan cleanup işi eklemek
- Delegation/operator/incident state'ini shared backend ile distributed coordination'a taşımak

## 2026-04-11 — Delegation issuance için two-person approval + fresh-session step-up kararı
### Problem
Dünkü tenant-scoped delegation modeli roster deadlock riskini açtı ama issuance tarafında üç kritik güvenlik açığı bıraktı:
1. Delegation grant'i tek admin aksiyonu ile anında `active` oluyordu; ikinci bir operatör onayı olmadan break-glass yetki üretilmesi separation-of-duties ilkesini deliyordu.
2. Dashboard üzerinden eski bir UI oturumu ile delegation create/revoke yapılabiliyordu; hassas delegation mutasyonları için taze re-authentication / step-up zorlaması yoktu.
3. Dashboard ve API yüzeyinde pending approval yaşam döngüsü, approval expiry görünürlüğü ve request/approve audit zinciri bulunmadığı için delegation issuance kararları yeterince izlenebilir değildi.

### Seçenekler
- A: Mevcut active delegation issuance modelini koruyup operasyon disiplinine güvenmek
- B: Sadece create sırasında ikinci operator roster check eklemek ama ayrı approval nesnesi oluşturmamak
- C: Delegation issuance akışını `pending_approval -> active` yaşam döngüsüne çevirmek, ayrı approve endpoint'i eklemek ve UI session freshness step-up zorlamak

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/security/export/operator-delegations` artık doğrudan aktif grant değil, `pending_approval` request üretiyor. Yeni `POST /v1/security/export/operator-delegations/:grantId/approve` endpoint'i ikinci operatör onayı ile grant'i aktive ediyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Delegation approval two-person enforced hale getirildi. Requester kendi talebini, delegate principal ise kendi grant'ini approve edemiyor; approval note zorunlu tutuluyor ve approval TTL dolarsa request fail-closed `approval_expired` statüsüne materialize ediliyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Delegation create/approve/revoke mutasyonlarında `ui_session` auth için fresh-session step-up eklendi. Taze olmayan dashboard oturumu `403 permission_error` alıyor; doğrudan API key ile gelen admin akışı desteklenmeye devam ediyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Audit zinciri `security_export_operator_delegation_requested|issued|consumed|revoked` event setiyle genişletildi; dashboard delegation tablosu pending approval, approval deadline, requester/approver ve approval note görünürlüğü kazandı.
5. **Kalite / operasyon iyileştirmesi:** Delegation store yeni statüler (`pending_approval`, `approval_expired`) ve alanlarla (`requested_by`, `requested_at`, `approved_by`, `approved_at`, `approval_expires_at`, `approval_note`) genişletildi; focused contract + unit testler step-up, second approval, expiry ve delegated recovery workflow senaryolarını kapsayacak şekilde yenilendi.

### Gerekçe
- Break-glass delegation'ın kendisi güvenlik istisnası olduğu için issuance akışı tek imza ile aktif grant üretmemeliydi.
- UI session freshness step-up olmadan uzun süre açık kalmış dashboard oturumları delegation issuance yüzeyinde gereksiz risk oluşturuyordu.
- Pending approval yaşam döngüsü ve audit telemetry, delegation kararını görünür ve geri izlenebilir hale getirerek production incident operasyonunu daha güvenli yapıyor.

### Etki
- Delegation issuance artık gerçek two-person approval modeline geçti; request ve approval adımları ayrıldı.
- Dashboard kullanıcıları hassas delegation mutasyonlarında taze session veya doğrudan API key step-up kullanmak zorunda.
- Break-glass delegation lifecycle'ı pending, approval-expired, active, consumed ve revoked durumlarıyla operasyonel olarak izlenebilir hale geldi.

### Bilinçli Olarak Ertelenenler
- Delegation/operator roster principal çözümlemesini external IdP/group sync ile besleme
- UI session freshness yerine WebAuthn/cryptographic re-auth step-up ekleme
- Delegation/incident/policy/audit/session state'ini gerçek shared backend'e taşıma

## 2026-04-10 — Tenant-scoped break-glass / JIT delegated operator approval kararı
### Problem
Dünkü tenant-scoped operator roster / RBAC control plane geniş admin yüzeyini kapattı; ancak production incident operasyonunda üç kritik boşluk kaldı:
1. `roster_required` posture'u güvenliği yükseltti ama roster dışındaki gerçek acil durum operatörleri için kontrollü, dar kapsamlı bir istisna yolu yoktu; bu da incident anında operasyonel deadlock riski doğuruyordu.
2. Geçici yetki vermek için tek seçenek tenant policy'yi gevşetmek veya geniş admin erişimi vermekti; incident, action ve TTL ile sınırlı tek kullanımlık delegation modeli bulunmuyordu.
3. Dashboard/API tarafında delegation issue/list/revoke görünürlüğü ve delegation kullanımına dair ayrı audit telemetry olmadığı için break-glass kararları kanıt zincirinde izlenemiyordu.

### Seçenekler
- A: Sıkı roster modelini koruyup gerçek acil durumlarda runbook/manual override ile ilerlemek
- B: Incident sırasında tenant operator policy'yi geçici olarak `open_admins` moduna çekmek
- C: Tenant-scoped, incident-scoped, action-scoped, TTL bazlı ve tek kullanımlık JIT delegated approval control plane'ini eklemek

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/security/export/operator-delegations`, `GET /v1/security/export/operator-delegations` ve `POST /v1/security/export/operator-delegations/:grantId/revoke` endpointleri eklendi. Dashboard delegation tablosu ve aksiyonları ile tenant admin, belirli incident ve action için geçici operator delegation issue/revoke yapabiliyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Delegation grant'leri tenant, incident, action, delegated operator ve TTL ile daraltıldı; self-delegation reddediliyor, aktif olmayan veya bulunamayan incident için create isteği fail-closed `404` dönüyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Delivery incident authorization zinciri artık roster yetkisi yoksa yalnızca eşleşen aktif delegation grant ile ilerliyor; başarılı `acknowledge`, `clear_request` veya `clear` sonrasında grant tek kullanımlık consume edilerek replay penceresi kapatılıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Delegation issue, consume ve revoke olayları ayrı audit event tipleriyle kaydediliyor (`security_export_operator_delegation_issued|consumed|revoked`, `security_export_break_glass_activity`); break-glass kullanımı kanıt zincirinde görünür hale geliyor.
5. **Ops / kalite iyileştirmesi:** API hata yüzeyi delegation create path'inde `invalidRequest(...)` ve `apiError(...)` ayrımıyla sertleştirildi; dashboard, README ve env dokümantasyonu yeni delegation posture'u ile güncellendi.

### Gerekçe
- Sıkı roster modeli güvenliydi ama operasyonel esneklik olmadan gerçek incident anında yanlış türde bir sertliğe dönüşebilirdi.
- Policy'yi genişletmek yerine incident/action scoped delegation vermek least-privilege posture'u koruyup acil durum işleyişini açar.
- Tek kullanımlık consume modeli ve audit telemetry, break-glass yetkisini kalıcı yetki genişlemesine dönüştürmeden yönetilebilir kılar.

### Etki
- Tenant admin, operator policy'yi gevşetmeden belirli incident aksiyonu için geçici yetki verebiliyor.
- Roster dışı ama yetkilendirilmiş acil durum operatörü yalnızca scope edilmiş delegation ile işlem yapabiliyor.
- Break-glass issuance, kullanım ve revoke akışları dashboard + API + audit feed üzerinden uçtan uca izlenebiliyor.

### Bilinçli Olarak Ertelenenler
- Delegation roster ve principal çözümlemesini external IdP/group sync ile besleme
- Delegation/incident store'u shared backend'e taşıma ve multi-instance coordination sağlama
- Delegation issuance için ikinci approver veya kriptografik step-up approval modeli

## 2026-04-09 — Tenant-scoped security export operator roster / RBAC control plane kararı
### Problem
Dünkü canary-backed clear request + four-eyes recovery akışı incident reopen riskini ciddi biçimde düşürdü; ancak production operasyonunda üç kritik boşluk kaldı:
1. `tenant:admin` scope taşıyan herhangi bir admin, incident acknowledge, clear-request ve clear approval adımlarının tamamını başlatabiliyordu; görev ayrımı yoktu.
2. Four-eyes modeli ikinci operatör gerektiriyordu ama bu ikinci operatörün hangi tenant içi role ait olduğu tanımlanmıyordu; least-privilege yerine geniş admin yüzeyi kalıyordu.
3. Deployment seviyesinde ayrı incident commander / recovery requester / recovery approver roster'ı tanımlansa bile API'nin bunu zorunlu uygulayan ayrı bir control plane'i yoktu.

### Seçenekler
- A: Mevcut four-eyes modeli koruyup runbook/disiplin ile role ayrımını operasyona bırakmak
- B: Sadece approval adımına tek bir allowlist ekleyip acknowledge ve clear-request akışını açık bırakmak
- C: Tenant-scoped operator-policy control plane + action bazlı roster enforcement + audit telemetry paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/security/export/operator-policy` endpointleri eklendi. Tenant, incident operator policy'yi `open_admins` veya `roster_required` modunda yönetebiliyor; roster alanları `acknowledge`, `clear_request`, `clear_approve` olarak ayrıldı.
2. **Ciddi güvenlik iyileştirmesi #1:** Delivery incident workflow artık acknowledge, clear-request ve clear approval aksiyonlarında action bazlı operator authorization çalıştırıyor. `roster_required` modunda explicit roster dışında kalan admin denemeleri fail-closed `403` ile reddediliyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Yetkisiz operator aksiyonları yeni audit event ile kaydediliyor (`security_export_operator_action_denied`), policy update/reset değişiklikleri ayrıca audit feed'e yazılıyor. Böylece denied recovery denemeleri görünür ve incelenebilir hale geldi.
4. **Ciddi güvenlik iyileştirmesi #3:** Deployment default roster env'leri, principal üst sınırı ve validation katmanı eklendi. Backward-compatible geçiş için varsayılan mod `open_admins`; fakat deployment default roster env'leri doluysa effective posture otomatik `roster_required` oluyor.
5. **DX / kalite iyileştirmesi:** Ayrı contract test dosyası, operator authorization unit testleri ve dokümantasyon/env örnekleri güncellendi; tenant operator RBAC değişikliği regression güveniyle teslim edildi.

### Gerekçe
- Four-eyes recovery modeli role separation olmadan hâlâ geniş admin yüzeyine dayanıyordu.
- Incident commander, recovery requester ve recovery approver rollerini API seviyesinde ayırmak, operasyon disiplini yerine enforce edilen güvenlik kuralı üretir.
- Backward-compatible default sayesinde mevcut deployment'lar kırılmadan ilerlerken, roster tanımlayan kurulumlar aynı gün daha sert posture'a geçebilir.

### Etki
- Tenant içindeki incident recovery zinciri artık action bazlı explicit operator roster ile kontrol edilebiliyor.
- Ayrı rol atanmamış admin kullanıcılar recovery adımlarını by-pass edemiyor.
- Audit feed denied operator aksiyonlarını ve policy mutasyonlarını kanıt olarak tutuyor.

### Bilinçli Olarak Ertelenenler
- Operator roster'ı external IdP/group sync ile besleme
- Shared backend / multi-instance distributed operator policy store
- Recovery approval için JIT approval token veya time-bound delegated approval modeli

## 2026-04-08 — Canary-backed incident clear request + four-eyes approval kararı
### Problem
Dünkü incident ack/manual clear paketi quarantine hedeflerini fail-closed tuttu; ancak production operasyonunda üç kritik boşluk kaldı:
1. Cooldown sonrası clear kararı hâlâ tek operatörün inisiyatifine bağlıydı; yanlış veya acele clear, bozuk webhook/SIEM hedefini tekrar açabilirdi.
2. Clear öncesi hedefin gerçekten toparlandığını kanıtlayan canlı bir delivery doğrulaması yoktu; operatör yalnızca panel notuna güveniyordu.
3. Incident oluştuğunda hedef URL redacted tutulduğu için aynı hedefe güvenli recovery/canary akışı için ayrı, encrypted recovery state gerekmiyordu ve mevcut model bunu expose etmiyordu.

### Seçenekler
- A: Mevcut ack + manual clear modelini koruyup runbook notu eklemek
- B: Sadece ikinci operatör onayı ekleyip canlı canary doğrulamasını ertelemek
- C: Canary-backed clear request endpointi + four-eyes clear enforcement + encrypted target recovery material paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/security/export/delivery-incidents/:incidentId/clear-request` endpointi ve dashboard aksiyonu eklendi; sistem aktif incident hedefi için canlı canary delivery koşup ikinci operatör onayı bekleyen clear request üretiyor.
2. **Ciddi güvenlik iyileştirmesi #1:** `POST .../clear` artık doğrudan tek operatör clear yapmıyor; pending clear request ve ikinci operatör şartı olmadan incident çözülmüyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Clear request yalnızca canlı canary delivery 2xx kabul edilirse oluşuyor; hedef toparlanmadan quarantine açılamıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Canary sonucu TTL ile sınırlandırıldı, requester kendi request’ini approve edemiyor ve stale request/policy drift durumunda clear fail-closed reddediliyor.
5. **Operasyonel güvenlik iyileştirmesi:** Delivery hedefinin recovery için gereken raw URL’i API’ye sızdırmadan encrypted-at-rest internal recovery material olarak saklanıyor; canary/clear akışı bu materyalden yeniden hydrate ediliyor.

### Gerekçe
- Incident recovery artık “not yazıp aç” seviyesinden çıkıp kontrollü change-management akışına geçti.
- Canary doğrulaması olmadan yapılan reopen kararı operatör yanılgısına fazla bağımlıydı.
- Encrypted target recovery olmadan canary feature’ı ya hiç çalışmayacak ya da redacted state tasarımını delmek zorunda kalacaktı.

### Etki
- Problemli destination’lar ancak canlı canary + ikinci operatör onayı ile tekrar açılıyor.
- Clear kararı artık hem teknik kanıta hem de two-person control’a bağlı.
- Dashboard incident paneli ack/clear ekranından gerçek incident recovery workflow’una yükseldi.

### Bilinçli Olarak Ertelenenler
- Clear approval için tenant içi rol bazlı ayrı approver havuzu / RBAC
- Multi-instance shared incident backend + distributed four-eyes workflow store
- Canary sonrası otomatik staged ramp-up / progressive delivery reopen

## 2026-04-07 — Delivery incident acknowledgement + manual clear control plane kararı
### Problem
Delivery analytics + automatic destination quarantine paketi problemli hedefleri görünür ve fail-closed hale getirdi; ancak production operasyonunda üç kritik boşluk kaldı:
1. Quarantine penceresi süre dolunca kendiliğinden kalkıyordu; bozuk webhook/SIEM hedefi operatör kontrolü olmadan tekrar açılabiliyor, aynı incident sessizce geri dönebiliyordu.
2. Dashboard/API tarafında aktif quarantine incident’ını kimin gördüğü, kimin üstlendiği ve ne zaman güvenli biçimde açıldığına dair explicit acknowledgement / clear workflow yoktu.
3. Operatör ekranı stale veriden clear denemesi yaparsa yanlış destination’ı erken açma riski vardı; optimistic concurrency/revision guard ve zorunlu açıklama kaydı eksikti.

### Seçenekler
- A: Mevcut auto-quarantine cooldown modelini koruyup sadece runbook notu eklemek
- B: Incident görünürlüğü verip clear aksiyonunu yine otomatik bırakmak
- C: Delivery incident control plane + operator ack/manual-clear workflow + stale revision guard + ack reset on new failures paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/acknowledge`, `POST /v1/security/export/delivery-incidents/:incidentId/clear` endpointleri ve dashboard incident aksiyonları eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Destination quarantine artık fail-open kalkmıyor; cooldown sonrası bile aktif incident operator acknowledgement + manual clear olmadan preview/sync/async/redrive zincirinde bloklu kalıyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Ack/clear aksiyonları optimistic revision guard ve zorunlu not ile korunuyor; stale dashboard ekranından gelen clear denemeleri 409 ile reddediliyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Acknowledged incident için yeni terminal failure gelirse acknowledgement otomatik sıfırlanıyor; eski onay yeni riskli durumu yanlışlıkla kapatmıyor.
5. **Ops / UX iyileştirmesi:** Delivery analytics summary artık active/unacked/clearable incident sayılarını, incident tablosu ise incident id + ack durumu + clear-after + aksiyonları gösteriyor.

### Gerekçe
- Auto-quarantine tek başına yeterli değildi; riskli delivery hedefinin tekrar açılması açıkça operatör iradesine bağlanmalıydı.
- Incident ownership ve çözüm izi olmadan dashboard yalnızca gözlem paneli olarak kalıyordu.
- Revision guard + zorunlu note kombinasyonu operasyonel hata/yarış durumlarında auditlenebilir ve güvenli bir workflow oluşturdu.

### Etki
- Problemli destination’lar artık süre dolsa bile sessizce tekrar açılmıyor.
- Operatör kim ack verdi, ne zaman clear etti ve hangi notla açtı bilgisi audit trail içinde tutuluyor.
- Dashboard security export paneli receipt ekranından gerçek incident response control plane seviyesine yükseldi.

### Bilinçli Olarak Ertelenenler
- Incident/quarantine state’ini delivery file store’dan ayrı shared backend’e taşıma
- Clear sonrası zorunlu başarılı canary delivery veya multi-operator approval workflow
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement

## 2026-04-06 — Delivery analytics + automatic destination quarantine kararı
### Problem
Security export delivery hattı artık dedicated policy plane, encrypted retry queue ve manual redrive yüzeyine sahipti; ancak production operasyonunda üç kritik boşluk kalmıştı:
1. Operatör hangi destination’ın bozulduğunu, success-rate trendini ve dead-letter yoğunlaşmasını tek ekranda göremiyordu; delivery health hâlâ receipt listesi seviyesindeydi.
2. Aynı tenant içinde tekrar tekrar başarısız olan veya dead-letter üreten bir webhook/SIEM hedefi için otomatik fail-closed guard yoktu; yanlış/bozuk hedefe teslim denemeleri sync, async ve redrive akışlarında tekrarlanabiliyordu.
3. Signing lifecycle contract suite içindeki global singleton state sızıntısı, delivery/signing güvenlik yüzeyinde test izolasyonunu zayıflatıyor ve regresyon güvenini düşürüyordu.

### Seçenekler
- A: Sadece receipt tablosuna birkaç ek kolon ekleyip operasyonu manuel yorumlamaya bırakmak
- B: Dashboard analytics ekleyip enforcement’i sonraya bırakmak
- C: Delivery analytics control plane + otomatik destination quarantine + async/redrive fail-closed guard + signing test isolation düzeltmesini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export/delivery-analytics` endpointi ve dashboard analytics/incident tablosu eklendi; status dağılımı, success-rate, timeline bucket’ları ve destination health verdict’leri görünür oldu.
2. **Ciddi güvenlik iyileştirmesi #1:** Aynı destination son pencere içinde tekrar tekrar terminal failure/dead-letter üretirse otomatik quarantine durumuna giriyor; preview, sync delivery, async enqueue ve manual redrive akışları fail-closed bloke ediyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Async enqueue path’i artık target resolution/quarantine hatalarını `blocked` receipt + `destination_quarantined` failure code ile güvenli biçimde yüzeye çıkarıyor; 500’e düşen belirsiz hata penceresi kapandı.
4. **Ciddi güvenlik iyileştirmesi #3:** Signing registry için test reset helper eklendi; contract suite içindeki global signing lifecycle state leakage kökten temizlenerek güvenlik regresyon paketi tekrar deterministik hale getirildi.
5. **Ops / UX iyileştirmesi:** Dashboard delivery paneli preview verdict’inde health/quarantine bilgisini, ayrı incidents tablosunda ise riskli destination’ları gösteriyor.

### Gerekçe
- Delivery control plane artık yalnızca “gönderildi/gönderilemedi” görünürlüğünde kalmamalı; incident yoğunlaşmasını ve kötü hedefleri operatöre doğrudan göstermeliydi.
- Repeated failure üreten destination’a fail-open devam etmek gereksiz gürültü, egress maliyeti ve yanlış operasyon riski oluşturuyordu.
- Güvenlik yüzeyindeki büyük değişiklikler, singleton state leakage düzeltilmeden güvenilir regresyon kanıtı üretemezdi.

### Etki
- Operatör delivery health, quarantined destination ve success-rate trendini API + dashboard üzerinden anında görebiliyor.
- Problemli destination’lar aynı tenant içinde otomatik soğutma/quarantine penceresine alınarak sync/async/redrive zincirinde tekrar vurulmuyor.
- Security export signing ve delivery test paketi tekrar deterministik/yeşil hale geldi.

### Bilinçli Olarak Ertelenenler
- Delivery incident/quarantine state’ini shared backend veya merkezi incident store’a taşıma
- Quarantine clear/ack workflow’u için ayrı operatör onay akışı
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement

---

## 2026-04-05 — Signing maintenance control plane + shared-store coordination kararı
### Problem
Dünkü signing lifecycle policy teslimi active key hijyenini fail-closed hale getirdi; ancak production operasyonunda üç kritik boşluk kaldı:
1. Signing maintenance yalnızca process-local timer/request-path tetikleme ile çalışıyordu; aynı signing store'u paylaşan çoklu instance'larda duplicate rotate/prune veya stale active key riski vardı.
2. Operatör dashboard/API üzerinden leader lease, son maintenance koşumu ve history görünürlüğünü alamıyor; manuel maintenance çalıştırmadan önce güvenli dry-run yapamıyordu.
3. Auto-rotation request-path üzerinde memory'de gerçekleşip persistence gecikirse, crash/pod restart anında yeni active key state'inin diskle drift etme riski oluşuyordu.

### Seçenekler
- A: Process-local timer modelini koruyup sadece runbook notu eklemek
- B: Shared backend gelene kadar maintenance visibility eklemeden beklemek
- C: Shared-store refresh + lease tabanlı leader coordination + manual maintenance control plane + dashboard history paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export/signing-maintenance` ve `POST /v1/security/export/signing-maintenance/run` ile leader lease, revision, history ve admin dry-run/execute akışı açıldı.
2. **Ciddi güvenlik iyileştirmesi #1:** Signing store her kritik operasyon öncesi diskten rehydrate ediliyor; aynı store'u paylaşan instance'lar stale active key ile imzalama yapmıyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Lease tabanlı maintenance koordinasyonu ile auto-rotate/prune mutasyonlarını tek lider instance yazıyor; follower instance'lar store refresh ile güncel active key'e hizalanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Rotation/policy-maintenance state'i sync atomic persistence ile diske yazılıyor; memory-only drift ve crash-window riski daraltılıyor.
5. **Ops / UX iyileştirmesi:** Dashboard signing paneli maintenance summary, history tablosu ve dry-run/execute aksiyonları kazandı; manual maintenance koşumları audit feed'e yazılıyor.

### Gerekçe
- Çoklu instance'a hazırlık yalnızca roadmap maddesi olarak bırakılamazdı; signing key hygiene yüzeyi artık shared store davranışıyla uyumlu olmalıydı.
- Operatör görünürlüğü olmadan auto-rotation güvenliği artsa bile bakım akışı kara kutu olarak kalıyordu.
- Sync persistence ve leader lease, shared backend gelene kadar local-file modelinin en yüksek etkili riskini daraltıyor.

### Etki
- Shared signing store kullanan instance'lar rotate sonrası aynı active key'e hizalanıyor.
- Manual maintenance artık güvenli dry-run + auditlenebilir execute akışıyla yönetilebiliyor.
- Dashboard/API signing control plane'i key listesi seviyesinden gerçek maintenance operasyon yüzeyine yükseldi.

### Bilinçli Olarak Ertelenenler
- Delivery queue/audit/policy/session store’larını gerçek shared backend’e taşıma
- Delivery policy için rollout analytics, trend kartları ve operatör playbook akışı
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement

---

## 2026-04-04 — Signing lifecycle policy + auto-rotation guard kararı
### Problem
Security export signing registry artık Ed25519 + JWKS ile dış doğrulamayı destekliyordu; ancak production güvenlik modelinde üç kritik boşluk kalmıştı:
1. Active signing key yalnızca manuel rotate ediliyordu; overdue/expired anahtarlar için otomatik lifecycle policy ve sağlık görünürlüğü yoktu.
2. Verify-only anahtarlar retention politikası olmadan JWKS yüzeyinde gereğinden uzun kalabiliyordu; bu hem gereksiz public verification surface hem de key hygiene sorunu yaratıyordu.
3. Dashboard/API tarafında signing health yalnızca key listesi seviyesinde görünüyordu; operatör rotate/expire/warn eşiklerini yönetemiyor ve fail-closed posture'u kontrol edemiyordu.

### Seçenekler
- A: Mevcut manuel rotation modelini koruyup sadece dokümantasyon uyarısı eklemek
- B: Auto-rotation eklemeden yalnızca dashboard metriklerini genişletmek
- C: Lifecycle policy API + auto-rotation guard + verify-only retention pruning + dashboard health control plane paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT /v1/security/export/signing-policy` endpointleri ve dashboard policy formu ile operatör auto-rotate / expire / warn / verify-retention eşiklerini yönetebilecek.
2. **Ciddi güvenlik iyileştirmesi #1:** Security export signing registry active key rotate süresi dolduğunda export/delivery öncesi otomatik rotation yapabilecek; auto-rotation kapalıysa expired key ile imzalama fail-closed reddedilecek.
3. **Ciddi güvenlik iyileştirmesi #2:** Verify-only anahtarlar retention süresi dolunca otomatik prune edilerek public JWKS yüzeyi daraltılacak.
4. **Ciddi güvenlik iyileştirmesi #3:** `/v1/security/summary` ve `/v1/security/export/keys` signing lifecycle health + alert durumunu expose edecek; manual rotate/policy update aksiyonları audit log’a yazılacak.
5. **Ops / UX iyileştirmesi:** Dashboard signing paneli health status, rotate due / expire görünürlüğü ve policy kaydetme akışı kazanacak.

### Gerekçe
- Export evidence zinciri asymmetric ve production-grade olsa da uzun ömürlü active key, anahtar hijyeninde operasyonel risk bırakıyordu.
- Verify-only key retention olmadan JWKS yüzeyi zamanla şişer ve gerekli minimum public verification surface ilkesinden uzaklaşır.
- Policy ve health görünürlüğü olmadan operatör ancak manuel rotate ile reaksiyon verebiliyordu; proaktif lifecycle control plane gerekiyordu.

### Etki
- Export/delivery signing hattı artık lifecycle-aware ve fail-closed posture ile çalışacak.
- Active key expiry posture’u dashboard + API üzerinden görünür ve yönetilebilir hale gelecek.
- Public JWKS yalnızca retention içindeki verify-only anahtarları yayınlayacak.

### Bilinçli Olarak Ertelenenler
- Delivery queue/audit/policy/session store’larını shared backend’e taşıma
- Delivery policy için rollout analytics, trend kartları ve operatör playbook akışı
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement

---

## 2026-04-03 — Delivery egress policy plane + target preview kararı
### Problem
Security export delivery hattı dayanıklı hale gelmişti; fakat production güvenlik modelinde üç kritik boşluk kalmıştı:
1. Export webhook/SIEM egress allowlist’i hâlâ RAG remote source policy ile paylaşıldığı için en az ayrıcalık (least-privilege) sınırı bulanıktı.
2. Allowlist host-seviyesindeydi; aynı host altındaki yanlış path/hedeflere delivery gönderimini kısıtlayan ayrı bir path-scope policy yoktu.
3. Operatör hedef URL’yi gerçek delivery yapmadan önce preflight doğrulayamıyor, hangi kuralın eşleştiğini ve pinli IP’yi dashboard/API üzerinden göremiyordu.

### Seçenekler
- A: Remote source policy paylaşımını koruyup yalnızca dokümantasyon uyarısı eklemek
- B: Delivery egress’i tamamen kapatmak
- C: Dedicated delivery-egress policy plane + path-prefix allowlist + preflight target preview + dashboard control plane paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/security/export/delivery-policy` ve `POST /v1/security/export/deliveries/preview` ile operatör delivery hedefini göndermeden önce preview edip policy’yi ayrı yönetebilecek.
2. **Ciddi güvenlik iyileştirmesi #1:** Export delivery allowlist’i remote RAG policy’den ayrılacak; dedicated tenant/deployment delivery-egress policy plane ile egress boundary netleşecek.
3. **Ciddi güvenlik iyileştirmesi #2:** Allowlist `host + path-prefix` kuralı seviyesine inecek; aynı host üzerinde yanlış webhook path’lerine giden teslimler fail-closed bloke edilecek.
4. **Ciddi güvenlik iyileştirmesi #3:** Preview/policy update/reset audit telemetry ile operatör görünürlüğü ve olay izi güçlenecek.
5. **Ops / UX iyileştirmesi:** Dashboard delivery paneli artık policy yönetimi + preflight preview akışı sunacak.

### Gerekçe
- Security export egress, RAG fetch ile aynı policy yüzeyine bağlı kaldığında operasyonel kolaylık sağlasa da güvenlik sınırını gereğinden geniş tutuyordu.
- Path-prefix scope olmadan allowlisted bir host içindeki yanlış endpoint’lere kanıt teslimi yapılabilirdi.
- Preview yüzeyi, güvenli operatör deneyimi ve düşük hata oranı için production gerekliliğidir.

### Etki
- Export delivery, bağımsız ve daha dar bir egress policy ile yönetilecek.
- Webhook/SIEM hedefleri host+path scope ile daha deterministik hale gelecek.
- Dashboard/API, delivery göndermeden önce policy verdict + matched rule + pinned address görünürlüğü sağlayacak.

### Bilinçli Olarak Ertelenenler
- Delivery queue/audit/policy/session store’larını shared backend’e taşıma
- Signing key’ler için otomatik expiry/rotation scheduler + alerting
- Delivery destination’lar için multi-step approval workflow / RBAC onay zinciri

---

## 2026-04-02 — Dead-letter redrive + anti-rebinding pinning kararı
### Problem
Security export delivery hattı dayanıklıydı ama production operasyonunda üç kritik boşluk kalmıştı:
1. Dead-letter receipt düşen export teslimleri için güvenli, operatör dostu manual redrive yüzeyi yoktu.
2. Remote RAG URL preview/ingest tarafında public DNS resolve sonrası gerçek connect aynı IP’ye zorlanmadığı için lookup→connect arası DNS rebinding penceresi kalıyordu.
3. Async delivery retry materyali şifreli tutulsa da hedef fingerprint ile bağlanmadığı için store-tampering veya kontrolsüz replay senaryolarında ek guard gerekiyordu.

### Seçenekler
- A: Dead-letter item’ları yeni delivery isteğiyle manuel yeniden oluşturup mevcut fetch davranışını korumak
- B: Sadece backend tarafında redrive ekleyip dashboard ve audit görünürlüğünü ertelemek
- C: Manual dead-letter redrive API + dashboard aksiyonu + lookup→connect DNS pinning + retry fingerprint guard paketini tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/security/export/deliveries/:deliveryId/redrive` endpointi ve dashboard aksiyonu ile dead-letter item aynı signed payload + aynı hedef ile tekrar kuyruğa alınabiliyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Remote RAG URL preview/ingest akışı artık her hop’ta resolve edilen public IP’ye lookup→connect pinning uyguluyor; redirect zinciri yeniden validate edilirken gerçek request de aynı pinli adrese gidiyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Async delivery retry/redrive materyali hedef fingerprint’i (`origin`, `host`, `path_hash`, `matched_host_rule`) ile saklanıyor; mismatch durumunda retry fail-closed dead-letter’a düşüyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Manual redrive bounded hale getirildi (`SECURITY_EXPORT_DELIVERY_MAX_MANUAL_REDRIVES`); aynı dead-letter item için sınırsız replay yapılamıyor ve `security_export_delivery_redriven` audit kanıtı üretiliyor.
5. **Ops / UX iyileştirmesi:** Dashboard delivery tablosu dead-letter satırında tek tık redrive, redrive_count ve source_delivery görünürlüğü veriyor.

### Gerekçe
- Dead-letter operasyonunun API ve dashboard üzerinden ilk sınıf vatandaş olması, incident-response süresini düşürür ve operatörü yeni export oluşturmaya zorlamaz.
- DNS rebinding penceresini yalnızca preflight resolve ile değil gerçek TCP connect anında kapatmak gerekiyordu.
- Encrypted retry queue tek başına yeterli değildi; hedef fingerprint doğrulaması ve bounded redrive politikası olmadan replay/tamper yüzeyi açık kalıyordu.

### Etki
- Security export control plane artık dead-letter recovery aksiyonunu da kapsıyor.
- Remote RAG URL fetch hattı gerçek request seviyesinde daha sert SSRF/anti-rebinding posture’ına geçti.
- Delivery retry/redrive zinciri auditlenebilir ve daha kontrollü hale geldi.

### Bilinçli Olarak Ertelenenler
- Delivery queue/audit/policy/session store’larını shared backend’e taşıma
- Signing key’ler için otomatik expiry/rotation scheduler + alerting
- Export egress için remote source policy’den bağımsız ayrı bir delivery-egress policy plane

---

## 2026-04-01 — Asymmetric security export signing registry kararı
### Problem
Security export hattı artık async queue + dead-letter ile dayanıklıydı; fakat üç kritik production boşluğu sürüyordu:
1. Export ve delivery imzası symmetric HMAC modelinde kaldığı için üçüncü taraf verifier/SIEM tarafında shared secret taşımadan doğrulama yapılamıyordu.
2. Active signing key rotation yüzeyi yoktu; key hygiene ve incident response anlarında kontrollü rollover eksikti.
3. Dashboard operatörü security export delivery’yi görebiliyor ama signing health / active key / public verification yüzeyini yönetemiyordu.

### Seçenekler
- A: Mevcut HMAC modeliyle devam edip verifier sorumluluğunu aynı sistem içinde bırakmak
- B: Sadece export bundle içine public key gömmek
- C: Ed25519 signing registry + verify-only rotation geçmişi + public JWKS discovery + dashboard control plane'i tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export/keys`, `POST /v1/security/export/keys/rotate` ve `/.well-known/smart-ai/security-export-keys.json` ile signing registry + rotation + public discovery yüzeyi açıldı.
2. **Ciddi güvenlik iyileştirmesi #1:** `GET /v1/security/export` çıktısı Ed25519 detached signature taşır hale getirildi; `POST /v1/security/export/verify` hem hash-chain hem signature doğruluyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Delivery headers symmetric HMAC yerine Ed25519 + key-id modeline yükseltildi; bundle signature ile korelasyon korunuyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Signing private key store plaintext değil; AES-256-GCM encrypted-at-rest tutuluyor ve rotate sonrası önceki key verify-only modda kalıyor.
5. **Ops / UX iyileştirmesi:** Dashboard signing key özeti, key tablosu ve rotate butonu ile control plane görünürlüğü genişletildi.

### Gerekçe
- Shared-secret tabanlı export verifier modeli güvenli ama dış sistem entegrasyonlarında operational friction üretiyordu; asymmetric model bu bağımlılığı kaldırdı.
- Key rotation olmadan signing yüzeyi uzun ömürlü tek anahtara bağımlı kalıyordu; verify-only geçmiş ile güvenli rollover sağlandı.
- Public JWKS discovery ve dashboard visibility, security evidence hattını auditlenebilir ve operatör dostu hale getirdi.

### Etki
- SIEM/forensics/verifier tarafı public JWKS ile export ve delivery kanıtlarını bağımsız doğrulayabilir.
- Admin tenant aktif signing key'i rotate edip önceki export'ların verify edilebilirliğini korur.
- Dashboard artık signing health yüzeyini de kapsayan gerçek bir security control plane haline geldi.

### Bilinçli Olarak Ertelenenler
- Dead-letter item için ayrı manual redrive endpointi
- Remote URL fetch hattında lookup→connect anti-rebinding pinning
- Delivery queue/audit/policy/session store’larını shared backend’e taşıma

---

## 2026-03-31 — Resilient security export delivery queue kararı
### Problem
Dünkü security export delivery hattı çalışıyordu; fakat production kullanımı için üç kritik boşluk sürüyordu:
1. Upstream 5xx / 429 / network hatalarında delivery tek denemede düşüyor ve evidence push manuel operasyona kalıyordu.
2. Retry ihtiyacı ortaya çıktığında export bundle retry store içinde plaintext tutulursa audit evidence dosya seviyesinde gereksiz risk taşıyacaktı.
3. Aynı export isteğinin tekrar tekrar kuyruğa alınması, duplicate delivery/replay flood ve egress abuse riski üretiyordu.

### Seçenekler
- A: Sync-only delivery ile devam edip operatöre manuel retry bırakmak
- B: Sadece basit in-memory retry eklemek
- C: Async delivery mode + encrypted retry queue + idempotency + dead-letter lifecycle + dashboard görünürlüğünü tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/security/export/deliveries` artık `mode=async` kabul ediyor; delivery receipt `queued/retrying/dead_letter` lifecycle’ı ile ilerleyebiliyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Retry queue payload’ı AES-256-GCM ile encrypted-at-rest saklanıyor; export bundle retry store’da plaintext tutulmuyor.
3. **Ciddi güvenlik iyileştirmesi #2:** `Idempotency-Key` ve tenant başına aktif async delivery limiti ile duplicate/replay flood ve egress abuse yüzeyi daraltıldı.
4. **Ciddi güvenlik iyileştirmesi #3:** Retryable HTTP/network sınıflandırması eklendi; non-retryable policy block ile transient upstream failure ayrıştırıldı ve dead-letter telemetry security feed’e taşındı.
5. **Ops / UX iyileştirmesi:** Dashboard artık sync/async mod seçebiliyor; receipt tablosu attempt_count, next_attempt_at ve dead-letter durumlarını gösterebiliyor.

### Gerekçe
- Security evidence export hattı production-grade sayılabilmek için transient upstream arızalarında otomatik toparlanabilmeliydi.
- Retry materyalini plaintext tutmak, güvenlik tarafında yeni bir veri sızıntısı yüzeyi yaratacaktı; bu yüzden queue storage şifreli tutuldu.
- Async queue, idempotency ve active-cap birlikte ele alınmadan duplicate delivery problemi kolayca maliyet ve gürültü üretebilirdi.

### Etki
- Tenant admin artık SIEM/webhook delivery’yi tek denemelik sync veya resilient async modda çalıştırabiliyor.
- Failed delivery’ler otomatik retry alıyor, limit aşımında `dead_letter` kanıtı security event feed’e düşüyor.
- Dashboard ve API operatöre delivery yaşam döngüsü görünürlüğü veriyor.

### Bilinçli Olarak Ertelenenler
- Dead-letter item için ayrı manual redrive endpointi
- Symmetric HMAC yerine asymmetric signing + key rotation registry
- Delivery queue/audit/policy store’larını shared backend’e taşıma

---

## 2026-03-29 — Tamper-evident security export pipeline kararı
### Problem
Security summary ve event feed tenant içinde görünür hale gelmişti; ancak üç kritik operasyon/güvenlik açığı sürüyordu:
1. Incident-response veya SIEM ingestion için audit evidence dışarı alınamıyordu.
2. Export edilen olayların transfer sonrası değiştirilip değiştirilmediğini doğrulayan hash-chain mekanizması yoktu.
3. Dashboard’da risk seviyesi görünse de operatörün tek tıkla security bundle indirme yüzeyi eksikti.

### Seçenekler
- A: Mevcut `/v1/security/events` + `/v1/security/summary` yüzeyiyle devam etmek
- B: Doğrudan webhook/SIEM push hattısına geçmek
- C: Admin-scope export API + verify endpoint + tamper-evident hash chain + dashboard download akışını tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export` ile tenant bazlı tamper-evident audit bundle export eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Audit eventler artık `sequence`, `prev_chain_hash`, `chain_hash` alanlarıyla zincirleniyor; export bundle üzerinde transfer sonrası bütünlük kanıtı üretilebiliyor.
3. **Ciddi güvenlik iyileştirmesi #2:** `POST /v1/security/export/verify` ile export bundle server-side doğrulanabiliyor; değiştirilmiş payload deterministik biçimde yakalanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Export ve verify yüzeyi `tenant:admin` scope arkasına alındı; read-only credential’lar summary okuyabilirken delil paketi export edemiyor.
5. **Ops / UX iyileştirmesi:** Dashboard artık gerçek `/v1/security/summary` verisini risk + integrity bilgisiyle gösteriyor ve tek tık security export indiriyor.

### Gerekçe
- Security event listesi incident-response için yararlıydı ama dış sisteme taşınabilir, doğrulanabilir evidence üretmiyordu.
- Hash-chain, ayrı bir KMS/SIEM yatırımı yapmadan audit log’u daha güvenilir hale getirmenin düşük maliyetli yolunu sağladı.
- Export/verify/dash akışını aynı koşumda teslim etmek, bu özelliği “yalnızca backend capability” olmaktan çıkarıp operasyonel olarak gerçekten kullanılabilir hale getirdi.

### Etki
- Tenant admin artık son pencerenin security evidence paketini indirip tekrar doğrulayabiliyor.
- Summary endpoint nihayet gerçek risk + integrity telemetry döndürüyor.
- Security audit log persistence’i eski snapshot’lardan geriye uyumlu biçimde hash-chain’e yükseltildi.

### Bilinçli Olarak Ertelenenler
- Webhook/SIEM push delivery hattı
- Public-key signed export manifest / dış doğrulayıcı dağıtımı
- UI session / audit / policy store için shared persistence backend

---

## 2026-03-28 — Tenant remote source policy control plane kararı
### Problem
Secure remote RAG preview/ingest hattı SSRF açısından fail-closed hale getirilmişti; ancak üretimde iki kritik açık kalmıştı:
1. Tenant bazlı remote kaynak onayı yoktu, yani arbitrary public URL’ler doğrudan ingest edilebiliyordu.
2. Unicode host / wildcard eşleşme kenar durumlarında allowlist bypass riski kalıyordu.
3. Operatörün dashboard üzerinden remote source policy’yi görüp yönetebileceği bir kontrol yüzeyi yoktu.

### Seçenekler
- A: Mevcut remote preview/ingest hattını koruyup operatör yönergesi ile devam etmek
- B: Remote URL ingest’i tekrar tamamen kapatmak
- C: Secure-by-default tenant remote source policy API + dashboard + audit telemetry + regression test paketiyle production-grade governance eklemek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/rag/remote-policy` endpointleri ve dashboard paneli ile tenant bazlı remote source policy control plane eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Deployment varsayılanı `preview_only` yapıldı; remote URL preview açık kalırken ingest artık explicit policy olmadan kapalı.
3. **Ciddi güvenlik iyileştirmesi #2:** `allowlist_only` modunda ingest yalnızca exact public host/IP veya `*.example.com` wildcard kurallarıyla açılıyor; Unicode host girişleri punycode normalize edilerek suffix/homograph bypass riski daraltıldı.
4. **Ciddi güvenlik iyileştirmesi #3:** Yeni audit eventleri (`rag_remote_policy_denied`, `rag_remote_policy_updated`, `rag_remote_policy_reset`) security feed ve risk scoring içine alındı.
5. **UX / DX iyileştirmesi:** Dashboard’da remote policy görünürlüğü ve düzenleme akışı eklendi; RAG belge metriği bug’ı da düzeltildi.

### Gerekçe
- Remote fetch güvenliği sadece SSRF bloklarıyla tamamlanmıyor; hangi dış kaynakların ingest edilebildiğinin policy seviyesinde yönetilmesi gerekiyor.
- Secure-by-default `preview_only` modu, operasyon ekibine gözlem yeteneği verirken doğrudan bilgi tabanı kirlenmesini ve kontrolsüz egress’i azaltıyor.
- Dashboard yönetimi olmadan bu yüzey yalnızca API seviyesinde kalacak ve operasyonel benimsenmesi zayıf olacaktı.

### Etki
- Remote URL ingest artık tenant onayı olmadan çalışmıyor.
- Allowlist kuralları daha deterministik ve denetlenebilir hale geldi.
- Security summary tekrarlayan remote policy deny sinyallerini risk göstergesi olarak sayabiliyor.

### Bilinçli Olarak Ertelenenler
- DNS lookup→connect pinning ile daha sert anti-rebinding koruması
- Multi-tenant approval workflow / insan-onaylı staged source approvals
- Security event webhook/SIEM export pipeline

---

## 2026-03-27 — Secure remote RAG URL ingest + preview gate kararı
### Problem
RAG URL ingest hattı doğrudan arbitrary remote fetch yaptığı için production riskleri oluşuyordu:
1. SSRF ile localhost / private-network / metadata IP hedeflerine erişim denenebilirdi.
2. Redirect zinciri, credential gömülü URL, disallowed MIME ve aşırı büyük body senaryolarında fail-closed guard yoktu.
3. Operatörün ingest öncesi URL’yi güvenli biçimde preview etmesini sağlayan kullanıcı-facing bir yüzey yoktu.

### Seçenekler
- A: Mevcut URL ingest akışını koruyup sadece dokümantasyon uyarısı eklemek
- B: URL ingest’i tamamen kapatmak
- C: Güvenli remote fetch policy + preview endpoint + audit telemetry + regression test paketi ile aynı koşumda production-grade sertleştirme yapmak

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/rag/url-preview` endpointi eklendi; operatör ingest öncesi `final_url`, `redirects`, `content_type`, `content_length_bytes`, `excerpt` gibi güvenli metadata ile preview alabiliyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Remote fetch hattı localhost / RFC1918 / link-local / CGNAT / reserved IP blokları, credential gömülü URL reddi ve port allowlist ile fail-closed hale getirildi.
3. **Ciddi güvenlik iyileştirmesi #2:** Redirect zinciri her hop’ta yeniden doğrulanıyor; redirect loop / missing location / unsafe target durumları bloklanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** MIME allowlist + byte cap + timeout guard eklendi; binary/oversized cevaplar ingest öncesi reddediliyor.
5. **Ops görünürlüğü:** `rag_remote_url_blocked`, `rag_remote_url_fetch_failed`, `rag_remote_url_previewed`, `rag_remote_url_ingested` audit eventleri eklendi.

### Gerekçe
- RAG surface doğrudan dış URL aldığı için SSRF ve payload-abuse riski diğer yüzeylerden daha yüksekti.
- Preview endpointi operatörün hatalı veya riskli kaynakları ingest etmeden önce ayıklamasını sağlıyor.
- Güvenlik, test ve docs aynı koşumda güncellenmeden bu alan production-grade sayılmazdı.

### Etki
- Remote RAG ingest artık public-safe URL policy ile çalışıyor.
- Tenant admin / operator akışı preview → ingest şeklinde daha kontrollü hale geldi.
- Bloklanan remote fetch denemeleri security feed’e düşerek incident-response görünürlüğü kazandı.

### Bilinçli Olarak Ertelenenler
- DNS pinning / custom dispatcher ile lookup→connect arası daha sert anti-rebinding koruması
- Tenant bazlı domain allowlist / approval workflow
- SIEM/webhook export ile blocked fetch eventlerinin dış sisteme aktarılması

---

## 2026-03-26 — Persistent security control plane + admin session response kararı
### Problem
İki üretim açığı aynı anda öne çıktı:
1. UI session store ve security audit store process-memory olduğu için restart sonrası güvenlik state'i kayboluyordu.
2. Tenant admin’in çalınmış/unutulmuş dashboard oturumlarını uzaktan görebileceği ve kapatabileceği bir incident-response yüzeyi yoktu.
3. Dependency taramasında Fastify için `GHSA-444r-cwp2-x5xf` advisory’si göründü; reverse-proxy başlık spoofing riski kapatılmalıydı.

### Seçenekler
- A: Mevcut memory-only store + manuel restart/re-login yaklaşımı ile devam etmek
- B: Sadece UI tarafında görünürlük ekleyip persistence katmanını ertelemek
- C: Hashed session persistence + kalıcı audit evidence + admin session inventory/revoke API + dependency patch aynı koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/ui/sessions`, `POST /v1/ui/sessions/:sessionId/revoke`, `POST /v1/ui/sessions/revoke-all` ile tenant admin session control plane eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** UI session store restart-resistant file-backed persistence'a taşındı; plaintext token saklanmıyor, yalnızca hash+metadata tutuluyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Security audit log restart-resistant file-backed persistence'a taşındı; bounded retention + sanitize/redaction korunuyor.
4. **Ciddi güvenlik iyileştirmesi #3:** `fastify` güvenlik advisory’sini kapatmak için bağımlılık güvenli sürüme yükseltildi.
5. **Ops/UX iyileştirmesi:** Dashboard'a aktif session görünürlüğü ve “Diğer Oturumları Kapat” akışı eklendi.

### Gerekçe
- Restart sonrası güvenlik evidence ve aktif session state'inin kaybolması hem operasyonel görünürlüğü hem incident-response hızını düşürüyordu.
- Session revoke-all yüzeyi olmadan ele geçirilmiş browser oturumlarını tenant admin hızlıca düşüremiyordu.
- Bağımlılık seviyesindeki bilinen advisory kapatılmadan production-grade teslim iddiası eksik kalırdı.

### Etki
- Tek instance prod kurulumlarında UI session ve audit evidence artık restart sonrası korunur.
- Dashboard üzerinden güvenli self-preserving bulk revoke akışı sağlandı.
- Dependency audit tekrar yeşile döndü (`npm audit --omit=dev` → 0 vulnerability).

### Bilinçli Olarak Ertelenenler
- UI session/audit persistence'ı Redis/Postgres gibi shared/distributed backend'e taşıma
- Session yönetimi için tenant içi tam kullanıcı/RBAC/approval workflow
- SIEM/webhook export pipeline

---

## 2026-03-21 — Async runtime cancellation + model allowlist security hardening kararı
### Problem
Async research işlerinde cancel çağrısı running task’i anında kesemiyor, idempotency kayıtları süresiz büyüyebiliyor ve model parametresi allowlist dışına taşarak maliyet/güvenlik riski üretebiliyordu.

### Seçenekler
- A: Mevcut best-effort cancel + açık model seçimi ile devam etmek
- B: Sadece UI seviyesinde uyarı eklemek
- C: Worker/LLM/tool zincirinde AbortSignal tabanlı gerçek cancellation + model allowlist enforcement + idempotency TTL/store cap

### Karar
**C seçildi:**
1. **Yeni özellik:** Running async job’lar için gerçek cancel/timeout davranışı (AbortSignal zinciri + `cancellation_reason`, `started_at`, `completed_at` alanları).
2. **Güvenlik iyileştirmesi:** `OPENROUTER_ALLOWED_MODELS` allowlist + model format/uzunluk doğrulaması (`api_model_rejected` audit event).
3. **Güvenlik iyileştirmesi:** Idempotency kayıtlarına TTL + tenant başına job store cap (`RESEARCH_IDEMPOTENCY_TTL_SECONDS`, `RESEARCH_MAX_JOBS_PER_TENANT`).
4. **Dayanıklılık iyileştirmesi:** LLM/tool fetch ve mcporter/qmd çağrılarına signal propagation ile timeout/cancel uyumu.

### Gerekçe
- Runtime’da gerçekten kesilemeyen işler maliyet, kuyruk şişmesi ve DoS riskini artırır.
- Model allowlist yoksa deployment policy dışı model kullanımı oluşabilir.
- Sınırsız idempotency/job birikimi bellek tüketimi ve tenant izolasyonunu zayıflatır.

### Etki
- Cancel edilen veya timeout olan işler artık `cancelled` + reason ile deterministik kapanır.
- Model probing ve allowlist dışı model kullanım denemeleri güvenlik feed’de görünür olur.
- Job/idempotency store büyümesi bounded hale gelir.

### Bilinçli Olarak Ertelenenler
- Job store’un Redis/Postgres’e taşınması
- Per-tenant dinamik model allowlist yönetim UI/API katmanı

---

## 2026-03-16 — Mimari yaklaşım seçimi
### Problem
Bu proje hızlı teslim + ürünleşebilir kalite + uzun görev desteğini aynı anda sağlamalı.

### Seçenekler
- A: Tek servis, senkron ağırlıklı
- B: Modüler monolith + async worker
- C: Baştan microservices

### Karar
**B seçildi:** Modüler monolith + async worker.

### Gerekçe
- MVP hızını korurken uzun görevleri izole eder.
- Güvenlik/policy katmanını net sınırlarla tutar.
- Gerektiğinde microservice'e evrilmeye izin verir.

### Etki
- İlk sürümde operasyonel karmaşıklık orta seviyede olur.
- Uzun araştırma akışları API threadlerini bloklamaz.

### Bilinçli Olarak Ertelenenler
- Baştan tam microservice parçalanması
- RL training pipeline entegrasyonu

### Tekrar Değerlendirme Tetikleri
- Eşzamanlı tenant yükü hızla artarsa
- Async job hacmi API katmanını zorlamaya başlarsa

---

## 2026-03-16 — Reuse stratejisi
### Problem
4 referans projeden nasıl yararlanılacağı netleşmeli (kopya mı, sentez mi?).

### Seçenekler
- Doğrudan kod kopyası
- Pattern-level sentez + temiz implement

### Karar
**Pattern-level sentez + temiz implement** seçildi.

### Gerekçe
- Lisans/güvenlik/bağımlılık riskini düşürür.
- Ürün ihtiyaçlarına göre daha temiz domain tasarımı sağlar.

### Etki
- Kısa vadede biraz daha implementasyon eforu gerekir.
- Uzun vadede bakım ve ölçeklenebilirlik kazanılır.

### Bilinçli Olarak Ertelenenler
- Referans repolardan birebir modül taşıma

### Tekrar Değerlendirme Tetikleri
- Lisans netliği + teknik gereksinim birebir reuse'u zorunlu kılarsa

---

## 2026-03-16 — API sözleşmesi önceliği
### Problem
İstemci entegrasyonu için ilk sabit nokta ne olmalı?

### Seçenekler
- Önce iç orkestrasyonu yazmak
- Önce dış API sözleşmesini sabitlemek

### Karar
**Önce API contract freeze**.

### Gerekçe
- Chatbot entegrasyonunu erken başlatır.
- İç mimari değişse bile istemci kırılmaz.

### Etki
- Implementasyon sırasında compatibility regresyonu azalır.

### Bilinçli Olarak Ertelenenler
- Erken dönemde geniş endpoint seti

### Tekrar Değerlendirme Tetikleri
- İstemci tarafı yeni endpoint ihtiyaçları doğurursa

---

## 2026-03-16 — RAG aktif etme kararı
### Problem
İç bilgi tabanı sorularında web tabanlı cevaplar yetersiz kalıyor, tenant-specific bilgi geri çağrımı gerekiyor.

### Seçenekler
- A: RAG yok, sadece web/wiki
- B: Tam external vector platform bağımlılığı
- C: Tenant izole, dosya tabanlı RAG çekirdeği + API

### Karar
**C seçildi:** Tenant izole, dosya tabanlı RAG çekirdeği + API endpointleri.

### Gerekçe
- Hızlı ürünleşme ve düşük operasyonel bağımlılık
- Güvenlikte tenant boundary'nin net korunması
- Sonraki sürümde vector backend'e evrilebilir mimari

### Etki
- İç doküman sorgularında kalite artışı
- Orchestrator plan/verifier akışına `rag_search` eklenmesi

---

## 2026-03-16 — Web search provider kararı (Brave + fallback)
### Problem
Web aramada kalite ve deterministik sonuç ihtiyacı var; tek sağlayıcıya bağımlılık kırılmalı.

### Seçenekler
- A: Sadece DuckDuckGo
- B: Sadece Brave
- C: Brave primary + DuckDuckGo fallback

### Karar
**C seçildi:** Brave primary, hata durumunda DuckDuckGo fallback.

### Gerekçe
- Brave ile daha zengin sonuç formatı
- Fallback ile çalışma sürekliliği
- Operasyonel kesinti riskini azaltma

### Etki
- `web_search` aracı dayanıklılığı arttı
- BRAVE_API_KEY olmayan ortamlarda mevcut davranış korunuyor

---

## 2026-03-16 — OpenRouter retry/backoff dayanıklılık kararı
### Problem
Upstream OpenRouter oran limitleri (429) ve geçici 5xx hataları kısa süreli olsa da cevap üretimini gereksiz yere başarısızlığa düşürüyor.

### Seçenekler
- A: Retry yok, tek deneme
- B: Sadece sabit gecikmeli retry
- C: Retry-After destekli, exponential backoff + jitter ile kontrollü retry

### Karar
**C seçildi:** Retry-After başlığına uyumlu, retryable status kodlarında exponential backoff + jitter.

### Gerekçe
- Geçici hatalarda başarı oranını artırır
- 429 davranışını upstream yönlendirmesine göre daha doğru yönetir
- Basit ve operasyonel olarak düşük riskli bir dayanıklılık iyileştirmesi

### Etki
- LLM çağrılarında transient failure kaynaklı hata oranı azalır
- Varsayılan model hedefi (`deepseek/deepseek-chat-v3.1`) ile günlük kullanım stabilitesi artar
- Retry parametreleri env üzerinden ayarlanabilir hale gelir

### Bilinçli Olarak Ertelenenler
- Circuit breaker + merkezi retry telemetry
- Tenant/endpoint bazlı adaptif retry politikaları

---

## 2026-03-16 — Orchestrator kalite kapıları (source diversity + loop guard + research budget)
### Problem
Araştırma akışında tekrar eden tool pass'leri, tek kaynaktan aşırı alıntı ve sınırsız query genişletmesi kaliteyi düşürebilir.

### Seçenekler
- A: Mevcut heuristik akışa dokunmamak
- B: Sadece daha fazla tool eklemek
- C: Verifier kalite kapısı + orchestrator loop guard + deep research bütçe/concurrency kontrolü

### Karar
**C seçildi:**
- Verifier için minimum citation + minimum source diversity kapısı
- Orchestrator için tekrarlayan tool-pass imza kırıcı (loop guard)
- Deep research için query budget + max concurrent research unit limiti

### Gerekçe
- Deer-Flow’daki loop/tool-stability yaklaşımını hafif bir middleware mantığıyla taşır.
- Open Deep Research’teki iteration/concurrency disiplinini ürün dostu env ayarlarına dönüştürür.
- Kaynak çeşitliliği düşük çıktılarda yanlış güven üretimini azaltır.

### Etki
- Düşük kanıtta otomatik genişletme daha kontrollü çalışır.
- Tek kaynağa dayalı cevaplar daha temkinli sentezlenir.
- Üretim yükü ve latency davranışı daha öngörülebilir olur.

---

## 2026-03-16 — Memory Layer kararı (memU pattern integration)
### Problem
Kullanıcı geçmişi, tercihleri ve profile dair sorular için yalnızca web/RAG yeterli değil; tenant bazlı konuşma hafızası gerekli.

### Seçenekler
- A: Memory katmanı eklememek
- B: Dış memory platformuna tam bağımlılık
- C: Tenant izole local memory plane + pre-retrieval decision + orchestrator memory tool

### Karar
**C seçildi:**
- `service/memory/*` altında tenant-izole memory store
- `/v1/memory/*` endpointleri
- `memory_search` tool + planner/verifier entegrasyonu
- Chat tarafında memory-worthy mesajlar için auto-capture

### Gerekçe
- memU’daki pre-retrieval decision yaklaşımıyla gereksiz retrieval çağrılarını azaltır.
- Kullanıcıya dair tercih/profil/habit bilgisini ürün içinde sürekli erişilebilir hale getirir.
- Dış bağımlılığı minimumda tutarak hızlı ürünleşme sağlar.

### Etki
- Kişiselleştirilmiş cevap kalitesi artar.
- Memory retrieval kanıtları (`memory://...`) verifier güvenine katkı sağlar.
- Tool plane daha güçlü ama policy ve tenant sınırları korunur.

### Bilinçli Olarak Ertelenenler
- Embedding tabanlı advanced memory ranker (şu an lexical + heuristic scoring)
- Memory encryption-at-rest için ayrı KMS katmanı
- Cross-tenant/global memory federasyonu

---

## 2026-03-16 — QMD local search entegrasyon kararı (OpenClaw + QMD pattern)
### Problem
Proje içi dokümanları (README/PRD/Task/Decision vb.) web aramaya göndermeden lokal ve hızlı aramak gerekiyor.

### Seçenekler
- A: Sadece mevcut `rag_search` ile ilerlemek
- B: QMD MCP/CLI ekleyip local docs arama katmanı açmak
- C: Harici hosted search servis bağımlılığı

### Karar
**B seçildi:** VPS'te kurulu `qmd` binary ile çalışan `qmd_search` tool eklendi.

### Gerekçe
- OpenClaw’daki qmd manager/process pattern’i güvenli CLI wrapper yaklaşımını doğruluyor.
- QMD'nin `search --json` çıktısı deterministik ve düşük gecikmeli.
- Lokal docs sorgularında dış web bağımlılığı azalıyor.

### Etki
- Planner/Verifier/Deep-Research pipeline artık `qmd_search` kullanabiliyor.
- Proje içi sorgularda cevap kalitesi ve kaynak doğrulanabilirliği artıyor.

### Bilinçli Olarak Ertelenenler
- `qmd query` (LLM rerank) default açılımı — şu an performans/stabilite için `qmd search` varsayılan.
- QMD index health için ayrı cron/scheduler otomasyonu.

---

## 2026-03-16 — Memory hotness + retrieval telemetry kararı (OpenViking pattern)
### Problem
Memory retrieval kalitesinde recency/frequency etkisi ve operasyonel görünürlük eksik kalıyordu.

### Seçenekler
- A: Sadece lexical skorla devam etmek
- B: Hotness scoring + retrieval metrikleri eklemek

### Karar
**B seçildi:**
- Hotness scoring (retrieval_count + recency half-life)
- Tenant retrieval telemetry (`totalQueries`, `avgLatencyMs`, `zeroResultQueries`)

### Gerekçe
- OpenViking’deki memory lifecycle yaklaşımı pratik ve düşük riskli.
- Telemetry olmadan retrieval kalitesini üretimde değerlendirmek zor.

### Etki
- Sık ve güncel memory kayıtları daha doğru sıralanıyor.
- `/v1/memory/stats` üzerinden retrieval davranışı izlenebiliyor.

---

## 2026-03-16 — Financial provider fallback kararı (OpenBB pattern)
### Problem
`financial_deep_search` tek source davranışında kırılgan kalıyor; provider hatasında finansal cevap kalitesi düşüyor.

### Seçenekler
- A: Stooq + web arama ile devam etmek
- B: OpenBB tarzı provider registry/fallback yaklaşımını finansal tool'a uyarlamak

### Karar
**B seçildi:**
- Finansal quote için çok provider fallback eklendi (`stooq` + `alpha_vantage`)
- Çok provider çıktısı için harmonization + spread analizi eklendi
- Query parser çoklu sembol desteği ile güçlendirildi

### Gerekçe
- OpenBB’de provider soyutlama ve fetcher lifecycle tasarımı sahada kendini kanıtlıyor.
- Tek kaynağa bağımlılık yerine fallback zinciri üretim dayanıklılığını artırır.
- Finansal sonuçları kaynaklar arası kıyaslayarak güvenilirlik sinyali üretir.

### Etki
- Finansal tool cevaplarında hata toleransı arttı.
- Provider farklılıkları kullanıcıya şeffaf raporlanabilir oldu (spread).
- Finansal tool test kapsamı genişledi.

---

## 2026-03-16 — MCP dayanıklılık katmanı kararı (circuit breaker + health endpoints)
### Problem
Remote MCP servislerinde geçici hata/timeout dalgalarında aynı sunucuya arka arkaya istek atılması hem yanıt süresini şişiriyor hem de kullanıcı deneyimini bozuyor; operasyonel görünürlük de sınırlı.

### Seçenekler
- A: Mevcut davranışla devam (health/circuit yok)
- B: Sadece timeout artırmak
- C: Sunucu-bazlı circuit breaker + adaptif timeout + health/reset endpointleri

### Karar
**C seçildi:**
- `service/mcp-health/*` ile global MCP circuit breaker katmanı
- `service/tools/tr-mcp-search.ts` içine success/failure telemetry ve circuit guard entegrasyonu
- `/v1/mcp/health`, `/v1/mcp/health/:serverId`, `/v1/mcp/reset` endpointleri

### Gerekçe
- Üretimde transient failure dalgalarında kontrollü degrade sağlar.
- Fallback yerine “ölç, koru, toparla” döngüsünü devreye alır.
- Ops ekibi için anlık sağlık görünürlüğü sunar.

### Etki
- Mevzuat/Borsa/Yargı MCP çağrıları daha dayanıklı hale geldi.
- Circuit-open durumda gereksiz upstream yükü engelleniyor.
- Test kapsamı yeni contract + unit testlerle genişledi.

### Bilinçli Olarak Ertelenenler
- Persisted telemetry (Prometheus/OTEL)
- Endpoint bazlı ayrı circuit profilleri

---

## 2026-03-16 — Türk domain MCP entegrasyon kararı (Mevzuat/Borsa/Yargı)
### Problem
Türkiye odaklı hukuk/finans sorgularında genel web arama yeterli kaynak doğruluğu ve yapısallık sağlamıyor.

### Seçenekler
- A: Sadece mevcut web/RAG akışında kalmak
- B: saidsurucu MCP sunucularını remote tool plane’e bağlamak

### Karar
**B seçildi:**
- `mevzuat_mcp_search`, `borsa_mcp_search`, `yargi_mcp_search` tool’ları eklendi.
- Entegrasyon `mcporter` üzerinden remote MCP call modeliyle yapıldı.
- Yargı tarafına empty-result için fallback eklendi (`search_emsal_detailed_decisions` → `search_bedesten_unified`).

### Gerekçe
- Mevzuat MCP: kanun/mevzuat sorgularında domain-specific precision sağlar.
- Borsa MCP: BIST/TEFAS/KAP odaklı local market coverage sağlar.
- Yargı MCP: emsal karar ve mahkeme içtihatlarına doğrudan erişim sağlar.

### Etki
- Planner/verifier artık hukuk/finans Türkiye bağlamında doğrudan MCP route edebiliyor.
- Deep research akışı domain MCP kaynaklarını da birleştiriyor.
- Tool plane kapsamı genişledi ama policy allowlist ile kontrol korunuyor.

### Bilinçli Olarak Ertelenenler
- MCP health check ve circuit-breaker telemetry paneli
- MCP credentials/headers için tenant bazlı gizli yönetim katmanı

---

## 2026-03-16 — MCP health persistence kararı (restart-resistant resilience)
### Problem
MCP circuit/latency metrikleri sadece process-memory’de tutulduğu için servis restart sonrası resiliency sinyalleri sıfırlanıyordu.

### Seçenekler
- A: Sadece in-memory tutmaya devam etmek
- B: Diskte snapshot persistence + startup seed restore eklemek

### Karar
**B seçildi:**
- `service/mcp-health/store.ts` ile snapshot read/write
- startup sırasında snapshot seed edilerek circuit/latency state restore
- runtime’da debounce’lu persistence scheduler
- ops için `POST /v1/mcp/flush` endpointi

### Gerekçe
- Restart sonrası tekrar ısınma (cold-start) etkisini azaltır.
- Operasyon ekiplerine daha stabil hata/trend görünürlüğü sağlar.
- Düşük karmaşıklıkla yüksek üretim etkisi üretir.

### Etki
- MCP dayanıklılık katmanı artık restart sonrası da tutarlı davranır.
- Circuit breaker state continuity iyileşti.
- Failover/fallback kararları daha hızlı ve daha doğru verilir.

---

## 2026-03-17 — Control Dashboard + Chatbot UI kararı
### Problem
API güçlü olsa da operasyonel kontrol ve son kullanıcı etkileşimi sadece API seviyesinde kalıyordu; ürün kullanılabilirliği düşüyordu.

### Seçenekler
- A: Sadece API bırakmak
- B: Hafif web control dashboard + chatbot UI eklemek

### Karar
**B seçildi:**
- `/ui/dashboard` ile operasyonel kontrol ekranı
- `/ui/chat` ile canlı chatbot arayüzü
- statik route katmanı (`service/api/routes/ui.ts`) ile server içinden servis

### Gerekçe
- Sunucu ayağa kalktıktan sonra kullanıcıya doğrudan kullanılabilir UI sağlar.
- Operasyonel metrikleri (MCP/memory/rag) tek ekranda görünür yapar.
- Harici frontend deploy bağımlılığı olmadan hızlı ürünleşme sağlar.

### Etki
- Ürün API-first + UI-ready hale geldi.
- Teknik olmayan kullanıcı için kullanım eşiği dramatik biçimde düştü.
- SRE/operasyon tarafında troubleshooting hızı arttı.

---

## 2026-03-17 — UI auth session abstraction kararı (API key localStorage kaldırma)
### Problem
Chat UI'da API key'in localStorage'da tutulması XSS veya paylaşılan cihaz senaryolarında gereksiz risk yaratıyordu.

### Seçenekler
- A: Mevcut localStorage davranışını korumak
- B: API key'i tamamen kaldırıp yalnızca backend-side login yapmak
- C: API key ile kısa ömürlü UI session token üretip /v1 çağrılarını token ile yapmak

### Karar
**C seçildi:**
- `POST /ui/session` endpointi ile API key doğrulanıp tenant-scope kısa ömürlü token üretiliyor.
- `/v1/*` auth middleware'i APP API key + UI session token kabul edecek şekilde genişletildi.
- Chat UI API key'i kalıcı saklamıyor; session token sadece `sessionStorage` içinde tutuluyor.

### Gerekçe
- Security posture'ı yükseltirken mevcut API sözleşmesini kırmaz.
- UI kullanımını basit tutar (tek adım “Oturum Aç”).
- Tenant isolation korunur (token tenant-scope doğrulaması).

### Etki
- API key'in browser persistence yüzeyi kaldırıldı.
- UI token süresi dolduğunda kontrollü re-auth akışı oluştu.
- Contract test kapsamı session issuance + tenant-scope doğrulamasıyla genişledi.

## 2026-03-17 — UI auth risk closure + MCP health shared persistence abstraction
- `/ui/session` için özel anti-bruteforce katmanı eklendi: IP+tenant bazlı başarısız giriş penceresi, geçici block ve `retry-after` header.
- Login hata mesajı `Invalid credentials.` olarak normalize edildi (input farklarından kullanıcı bilgisi sızmaması için).
- `POST /ui/session/revoke` endpoint’i eklendi; UI logout akışı bu endpoint üzerinden token revoke ediyor.
- UI session store artık token’ı plaintext map key olarak tutmuyor; SHA-256 hash key kullanıyor.
- MCP health persistence katmanı file/http modlu abstract backend’e geçirildi. `MCP_HEALTH_PERSIST_MODE=http` ile çoklu instance ortak persistence endpoint’i kullanılabiliyor; endpoint yoksa file fallback.

## 2026-03-17 — Cross-repo synthesis (MiroFish + deepagents + A-mem)
Analysis method: `mcporter` üzerinden `github-readonly` + `repomix` kullanıldı.

Uygulanan adaptasyonlar:
- **deepagents esinli plan/todo yaklaşımı**: Orchestrator planına `stages` checklist alanı eklendi (discover/domain/synthesis), metadata içinde görünür hale geldi.
- **MiroFish esinli aşamalı pipeline görünürlüğü**: Tool seçimleri aşama bazına map edilerek aşama durumları (`pending/running/done`) takip ediliyor.
- **A-mem esinli agentic memory linking**: Memory item’lara otomatik semantik `relatedMemoryIds` bağları eklendi (tenant scoped), search/list çıktısına yansıtıldı.

---

## 2026-03-18 — Production master key fail-fast kararı
### Problem
`MASTER_KEY_BASE64` tanımlı değilken servis deterministik dev fallback anahtarına düşebiliyordu; bu davranış production ortamında yanlış yapılandırma ile zayıf/öngörülebilir şifreleme riski yaratır.

### Seçenekler
- A: Mevcut fallback davranışını production'da da sürdürmek
- B: Production'da eksik/geçersiz anahtarda fail-fast olmak, dev/test fallback'i korumak

### Karar
**B seçildi:** `NODE_ENV=production` altında `MASTER_KEY_BASE64` yoksa veya 32 byte altı/geçersizse servis startup aşamasında hata verip durur.

### Gerekçe
- Güvenli varsayılanlar (secure-by-default) yaklaşımını uygular.
- Yanlış env konfigürasyonunu erken aşamada görünür kılar.
- Encryption-at-rest key yönetiminde operasyon disiplini sağlar.

### Etki
- Production deploy pipeline'larında secret eksikliği anında yakalanır.
- Geliştirme/test deneyimi bozulmaz (lokal fallback devam eder).
- Yanlış yapılandırmadan kaynaklı sessiz güvenlik zafiyeti riski azalır.

### Bilinçli Olarak Ertelenenler
- KMS/HSM entegrasyonu ve otomatik key rotation
- Startup secret health endpoint'i ve policy-as-code doğrulaması

---

## 2026-03-18 — Security telemetry + UI hardening kararı (dashboard sessionization)
### Problem
Security olayları runtime içinde görünür değildi; dashboard API key’i localStorage’da tutarak gereksiz tarayıcı risk yüzeyi yaratıyordu.

### Seçenekler
- A: Mevcut dashboard modelini korumak
- B: Sadece backend’de audit event toplayıp UI'yı değiştirmemek
- C: Tenant-scope security event feed + dashboard session token modeli + UI origin/header hardening

### Karar
**C seçildi:**
- `GET /v1/security/events` endpointi eklendi (tenant-scope audit feed)
- Dashboard auth modeli chat UI ile hizalandı (API key kalıcı saklanmıyor, kısa ömürlü session token)
- UI state-changing endpoint’lere (`/ui/session`, `/ui/session/revoke`) origin allowlist kontrolü eklendi
- UI static yanıtlarına CSP + güvenlik header’ları eklendi
- `x-tenant-id` format doğrulaması zorunlu hale getirildi

### Gerekçe
- Security operasyonları için doğrudan gözlemlenebilirlik sağlar.
- Browser-side key exposure riskini düşürür.
- Origin tabanlı istek hijack/CSRF benzeri riskleri azaltır.
- Header hardening ile clickjacking/MIME sniffing yüzeyi daraltılır.

### Etki
- Dashboard güvenlik posture’ı belirgin güçlendi.
- Tenant başına auth/rate-limit/session/origin olayları izlenebilir oldu.
- API kontratına yeni endpoint eklendi, test kapsamı genişledi.

### Bilinçli Olarak Ertelenenler
- Audit event persistence’in merkezi store’a taşınması (şu an process-memory bounded store)
- SIEM/OTEL export pipeline

---

## 2026-03-19 — OpenBB native tool entegrasyon kararı (no-code augmentation path)
### Problem
NOFX execution çekirdeğini bozmadan SMART-AI tarafında veri çeşitliliğini artırmak için OpenBB kaynaklarını doğrudan tool plane'e eklemek gerekiyor.

### Seçenekler
- A: Sadece mevcut `financial_deep_search` (stooq + alpha_vantage) ile devam etmek
- B: OpenBB'yi sadece dış araştırma notu seviyesinde bırakmak
- C: OpenBB API endpointlerini first-class tool (`openbb_search`) olarak entegre etmek

### Karar
**C seçildi:** `openbb_search` aracı eklendi ve planner/verifier/deep-research akışına bağlandı.

### Gerekçe
- OpenBB repo analizinde API endpointleri (`/api/v1/equity/price/quote`, `/api/v1/equity/price/historical`, `/api/v1/news/company`, `/api/v1/news/world`) doğrudan servislenebilir durumda.
- NOFX tarafını fork etmeden, SMART-AI'yı “analysis brain” olarak güçlendirme hedefiyle uyumlu.
- Tool-first entegrasyon, ileride provider/route genişletmesini düşük maliyetli hale getirir.

### Etki
- Finans/trading sorgularında OpenBB tabanlı market snapshot, trend ve haber özetleri üretilebiliyor.
- Verifier kalite kapısında OpenBB kanıtları güven sinyaline dahil edildi.
- Deep research akışı finans sorularında OpenBB pass ile genişledi.

### Bilinçli Olarak Ertelenenler
- OpenBB technical endpoints (`/api/v1/technical/*`) için payload zenginleştirme pipeline'ı
- OpenBB MCP server ile doğrudan tool discovery/autogen katmanı
- OpenBB response normalizasyonu için ayrı schema registry

---

## 2026-03-19 — Async research lifecycle hardening kararı (idempotent + cancellable jobs)
### Problem
Async research endpointi (`POST /v1/jobs/research`) duplicate submit, tenant başına job fırtınası ve runtime error message sızıntısı riskleri taşıyordu. Ayrıca operasyon tarafında job listesi ve güvenli cancel lifecycle eksikti.

### Seçenekler
- A: Mevcut minimal enqueue/get modeliyle devam etmek
- B: Sadece rate-limit artırıp uygulama katmanını değiştirmemek
- C: Job lifecycle’i üretim seviyesine çıkarmak (idempotency + active job cap + list/cancel + audit + redaction)

### Karar
**C seçildi:**
1. **Yeni özellik:** Job lifecycle endpointleri genişletildi.
   - `GET /v1/jobs`
   - `POST /v1/jobs/:jobId/cancel`
   - `POST /v1/jobs/research` için `Idempotency-Key` desteği
2. **Güvenlik sertleştirmesi:** Tenant başına aktif async job limiti eklendi (`RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT`).
3. **Güvenlik sertleştirmesi:** Idempotency key format doğrulaması + farklı payload ile replay conflict koruması eklendi.
4. **Güvenlik sertleştirmesi:** Job failure error mesajları redacted/sanitize edilerek secret sızıntı riski azaltıldı.
5. **Gözlemlenebilirlik:** Security event feed’e research job event tipleri eklendi.

### Gerekçe
- Duplicate submit ve retry storm durumlarında aynı işi tekrar tekrar çalıştırmamak maliyet/süre avantajı sağlar.
- Tenant başına aktif job sınırı, kaynak tüketimi tabanlı kötüye kullanım riskini azaltır.
- Error redaction, özellikle provider token/authorization parçalarının API response üzerinden sızmasını engeller.
- Job list/cancel endpointleri operasyonel kontrol ve güvenli recovery sağlar.

### Etki
- Async research yüzeyi artık replay-safe ve tenant bazlı kapasite kontrollü.
- Ops/UI katmanları queued/running/completed/failed/cancelled lifecycle’ı tek API ile izleyebilir.
- Güvenlik telemetry’sinde job kaynaklı olaylar da tenant bazlı raporlanabilir.

### Bilinçli Olarak Ertelenenler
- Running job için gerçek runtime cancellation (AbortSignal ile tool-level interrupt zinciri)
- Job store’un kalıcı bir backend’e taşınması (Redis/Postgres)
- Idempotency kayıtları için TTL + persistence policy

## 2026-03-20 — Security intelligence summary + header abuse hardening kararı
### Problem
Security event feed vardı ancak operasyon ekibi olayları elle okumadan risk seviyesini hızlı göremiyordu. Ayrıca header/payload boyutu suistimallerine karşı sınırlar açık tanımlı değildi.

### Seçenekler
- A: Sadece mevcut `/v1/security/events` listesini kullanmaya devam etmek
- B: Ayrı SIEM entegrasyonu gelene kadar beklemek
- C: Tenant-scope risk özet endpointi + dashboard görünürlüğü + header/payload boyut sertleştirmelerini aynı koşumda eklemek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/summary` endpointi eklendi (riskScore, riskLevel, alertFlags, topIps, byType).
2. **Güvenlik sertleştirmesi:** Authorization/Bearer/Tenant header boyut limitleri eklendi (`431` reject path).
3. **Güvenlik sertleştirmesi:** UI session login için oversized API key payload reddi eklendi.
4. **Güvenlik sertleştirmesi:** Security audit detaylarında secret redaction + normalize/sanitize katmanı eklendi.
5. **UX/ops:** Dashboard risk kartı ile 24h güvenlik riski tek bakışta görünür hale getirildi.

### Gerekçe
- Security operasyonlarında “event listesi” yerine “risk özeti” karar hızını artırır.
- Header abuse ve oversized payload reddi, auth yüzeyinde düşük maliyetli ama yüksek etkili bir sertleştirmedir.
- Audit detail redaction, telemetry üzerinden token/key sızıntısı riskini düşürür.

### Etki
- Tenant bazlı güvenlik posture tek endpoint ile ölçülebilir hale geldi.
- Dashboard artık sadece olay sayısı değil, risk seviyesi ve alarm bayraklarını da gösteriyor.
- Auth/UI giriş yüzeyinde header/payload kaynaklı kötüye kullanım penceresi daraltıldı.

### Bilinçli Olarak Ertelenenler
- Persisted audit analytics store (Redis/Postgres/SIEM)
- Anomali tespiti için zaman serisi tabanlı ML/istatistiksel model
- IP reputation/geo intelligence entegrasyonu

## 2026-03-24 — Tenant model policy yönetimi + fail-closed enforcement kararı
### Problem
Model allowlist yalnızca deployment seviyesinde tutuluyordu; tenant bazında daha dar, güvenli ve ürün odaklı model seti tanımlanamıyor, ayrıca model parametresi verilmediğinde tutarlı bir tenant default seçimi bulunmuyordu.

### Seçenekler
- A: Sadece deployment-level allowlist ile devam etmek
- B: UI tarafında pasif model etiketi gösterip backend davranışını değiştirmemek
- C: Tenant bazlı model policy API + default model fallback + fail-closed invalid policy enforcement

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/model-policy` ile tenant bazlı allowlist + default model yönetimi eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Chat ve async research job endpointleri artık tenant effective policy dışındaki modelleri reddediyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Deployment allowlist dışında tenant policy yazılamıyor; invalid/stale tenant policy durumunda sistem fail-closed davranıyor.
4. **Ops/telemetry iyileştirmesi:** `model_policy_updated`, `model_policy_reset`, `model_policy_change_rejected` audit eventleri eklendi.
5. **UX iyileştirmesi:** Dashboard policy yönetim paneli eklendi; chat UI tenant default modeli otomatik seçiyor.

### Gerekçe
- Tenant bazlı model sınırları maliyet, güvenlik ve ürün segmentasyonu için gerekliydi.
- Model parametresi zorunluluğu istemci entegrasyonunu gereksiz yere kırılgan yapıyordu.
- Deployment policy değiştiğinde stale tenant kayıtlarının sessizce geniş yetkiye düşmesi kabul edilemezdi.

### Etki
- Her tenant kendi güvenli model alt kümesine ve varsayılan modeline sahip olabiliyor.
- Model omission artık kontrollü biçimde tenant default üzerinden çalışıyor.
- Policy escape denemeleri ve reddedilen konfigürasyonlar security feed’de görünür hale geldi.

### Bilinçli Olarak Ertelenenler
- Model policy store’un Redis/Postgres gibi shared backend’e taşınması
- Policy değişiklikleri için role-based admin scopes / approver workflow
- Dashboard tarafında çok-tenant toplu policy yönetimi

---

## 2026-03-22 — UI session lifecycle hardening + zero-downtime token rotation kararı
### Problem
UI tarafında session token modeli vardı ancak üç kritik açık bulunuyordu:
1. Token yenileme akışı olmadığı için dashboard/chat tarafında token bitişi kullanıcı deneyimini kesiyordu.
2. Session store için tenant/global üst sınır olmadığından memory-DoS riski bulunuyordu.
3. Idle session kontrolü ve fingerprint doğrulaması eksik olduğundan token ele geçirilmesi durumunda kötüye kullanım penceresi uzundu.

### Seçenekler
- A: Sadece token TTL artırmak (kısa vadeli UX düzeltmesi, güvenlik kazanımı zayıf)
- B: Refresh endpoint ekleyip güvenlik katmanını olduğu gibi bırakmak
- C: Session lifecycle’ı uçtan uca sertleştirmek (refresh/introspection + idle timeout + UA binding + cap eviction + UI auto-refresh)

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `GET /ui/session` endpointi eklendi (aktif session introspection: expiry, idle window, remaining seconds)
   - `POST /ui/session/refresh` endpointi eklendi (token rotation; eski token anında geçersiz)
2. **Ciddi güvenlik iyileştirmesi #1:**
   - UI session’larda idle-timeout enforcement eklendi (`UI_SESSION_MAX_IDLE_SECONDS`)
   - `/v1/*` auth middleware artık session resolve sırasında `lastSeenAt` touch + idle expiry uygular
3. **Ciddi güvenlik iyileştirmesi #2:**
   - User-Agent fingerprint binding eklendi (token farklı UA ile kullanılırsa session düşürülür)
4. **Ciddi güvenlik iyileştirmesi #3:**
   - Tenant başına ve global aktif session cap eklendi (`UI_SESSION_MAX_SESSIONS_PER_TENANT`, `UI_SESSION_MAX_SESSIONS_GLOBAL`)
   - En eski tokenlar otomatik evict edilerek store büyümesi kontrol altına alındı
5. **Ops/telemetry genişletmesi:**
   - Yeni security event tipleri: `ui_session_rotated`, `ui_session_validation_failed`, `ui_session_refresh_failed`
   - Risk summary skorlama/flag mantığı session-anomaly sinyalleriyle güncellendi

### Gerekçe
- Session rotation + auto-refresh kombinasyonu kullanıcı deneyimini kesmeden güvenlik posture’unu yükseltir.
- Idle timeout + fingerprint binding, token theft etkisini anlamlı şekilde sınırlar.
- Session cap, bellek tüketimi tabanlı suistimalleri düşük maliyetle azaltır.

### Etki
- Dashboard/chat token kesintileri azaldı; token bitişine yakın otomatik refresh yapılabiliyor.
- UI auth yüzeyi replay/hijack ve resource abuse risklerine karşı daha dayanıklı hale geldi.
- Security event feed artık session-odaklı anomali sinyallerini de taşıyor.

### Bilinçli Olarak Ertelenenler
- Multi-signal device fingerprint (IP + UA + client-hints) ile adaptif risk scoring
- Session store’un process-memory yerine Redis’e taşınması
- Revoked token bloom-filter/denylist ile distributed revoke propagation

## 2026-03-25 — Scoped API keys + auth context + UI session origin binding

### Problem
1. Tenant auth modeli tek seviyeli olduğu için dashboard/read-only kullanım ile admin operasyonları arasında yetki ayrımı yoktu.
2. `PUT /v1/model-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset|flush` gibi hassas yüzeyler çalınmış veya aşırı yetkili credential ile gereksiz yere açık kalıyordu.
3. UI session token’ları `/v1/*` state-changing çağrılarda origin-bound değildi; token ele geçirilirse browser dışı/kötü origin kullanım penceresi gereğinden genişti.

### Seçenekler
- A: Mevcut tek-seviye anahtar modelini koruyup sadece dashboard tarafında buton gizlemek
- B: Tam tenant/user RBAC sistemi kurmak (yüksek etki ama tek günlük koşum için aşırı büyük)
- C: Scope tabanlı credential modeli + auth introspection + hassas endpoint gating + UI session origin binding

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `APP_API_KEY_DEFINITIONS` ile scope tanımlı credential registry eklendi.
   - Yeni endpoint: `GET /v1/auth/context`
   - Dashboard ve Chat UI artık aktif credential’ın scope’larını okuyup kontrol yüzeyini yetkiye göre otomatik ayarlıyor.
2. **Ciddi güvenlik iyileştirmesi #1:**
   - Scope hiyerarşisi tanımlandı: `tenant:read` → `tenant:operate` → `tenant:admin`
   - `/v1/model-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset`, `/v1/mcp/flush` admin scope gerektiriyor.
   - Legacy `APP_API_KEYS` backward-compatible olarak full admin davranışını koruyor.
3. **Ciddi güvenlik iyileştirmesi #2:**
   - UI session’lar artık giriş yapılan principal adını ve scope setini taşır; refresh/rotation akışında da bu yetki korunur.
   - Böylece read-only veya operate-only anahtarlar UI üzerinden admin aksiyonuna sıçrayamaz.
4. **Ciddi güvenlik iyileştirmesi #3:**
   - UI session token ile yapılan state-changing `/v1/*` çağrıları allowlisted Origin’e bağlandı.
   - Eksik veya uygunsuz origin, audit event ile 403 döner.
5. **Telemetry genişletmesi:**
   - Yeni event tipi: `api_scope_denied`
   - Risk summary artık tekrar eden privilege probing denemelerini `privilege_escalation_attempts` bayrağı ile işaretleyebilir.

### Gerekçe
- Tek turda production-grade ve geri uyumlu bir en düşük ayrıcalık (least privilege) katmanı kurmak mümkün oldu.
- Auth introspection sayesinde yalnızca backend enforcement değil, frontend operatör deneyimi de güvenli varsayılanlara geçti.
- Origin binding, UI session token’larının browser-tab context dışına taşınmasını zorlaştırarak gerçek saldırı yüzeyini küçültür.

### Etki
- Read-only dashboard erişimi ile admin operasyonları artık güvenli şekilde ayrışıyor.
- Chat UI, operate yetkisi olmayan session ile yanlışlıkla iş yükü başlatamıyor.
- Admin yüzeylerinde yetkisiz denemeler güvenlik feed’ine görünür şekilde düşüyor.

### Bilinçli Olarak Ertelenenler
- Tenant içi kullanıcı bazlı tam RBAC/approval workflow
- API key registry’nin env yerine merkezi secret backend’den yönetilmesi
- UI session store ve audit store’un shared/distributed persistence’a taşınması

---

## 2026-03-30 — Tamper-evident security export delivery + egress hardening
### Problem
1. Security export bundle’ları yalnızca indirilebiliyordu; SIEM/webhook tarafına güvenli, otomasyon dostu teslim yolu yoktu.
2. Export delivery eklendiği anda SSRF, private-network egress, replay ve secret leak riskleri doğacaktı.
3. Operatör tarafında hangi export’un nereye gittiği, başarı/başarısızlık durumu ve audit chain referansı görünür değildi.

### Seçenekler
- A: Sadece JSON download bırakmak (en güvenli ama operasyonel değeri düşük)
- B: Serbest URL’e `fetch()` ile POST atmak (hızlı ama production güvenliği zayıf)
- C: Tenant allowlist kontrollü, HTTPS-only, DNS-pinned, HMAC-imzalı delivery API + dashboard + receipt history

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `GET/POST /v1/security/export/deliveries` eklendi.
   - Dashboard’a webhook/SIEM delivery paneli ve recent receipt tablosu eklendi.
   - Export bundle artık tek tıkla dış sisteme gönderilebiliyor ve delivery geçmişi saklanıyor.
2. **Ciddi güvenlik iyileştirmesi #1:**
   - Delivery yalnızca HTTPS hedeflere açık.
   - Embedded credential içeren URL’ler reddediliyor.
   - Host, tenant remote source allowlist içinde değilse delivery bloklanıyor.
3. **Ciddi güvenlik iyileştirmesi #2:**
   - Hedef hostname public DNS üzerinden resolve edilip pinned address ile bağlanılıyor; private/link-local/reserved ağ egress’i reddediliyor.
   - Allowed port listesi ile gereksiz egress yüzeyi daraltıldı.
4. **Ciddi güvenlik iyileştirmesi #3:**
   - Her delivery için tenant-scoped HMAC header seti (`x-smart-ai-signature`, `content-digest`, timestamp/nonce metadata) üretildi.
   - Path/query değerleri loglanmıyor; receipt tarafında yalnızca redacted destination metadata tutuluyor.
5. **Telemetry / ops iyileştirmesi:**
   - Yeni audit event tipleri: `security_export_delivered`, `security_export_delivery_failed`, `security_export_delivery_blocked`
   - Risk summary artık delivery instability ve egress policy violation sinyallerini işaretleyebiliyor.
   - Receipt store sayesinde hangi export’un hangi chain head ile teslim edildiği izlenebilir hale geldi.

### Gerekçe
- Security export’un gerçek operasyonel değeri, sadece download değil güvenli teslim kabiliyetiyle ortaya çıkıyor.
- Serbest outbound POST modeli, audit ve security ürünü için kabul edilemez kadar geniş saldırı yüzeyi yaratır.
- Allowlist + DNS pinning + HMAC kombinasyonu tek günlük koşum içinde güçlü bir production baseline sundu.

### Etki
- Tenant admin’leri audit bundle’larını kontrollü şekilde SIEM/webhook tarafına push edebiliyor.
- Export egress yüzeyi audit’lenebilir, allowlist kontrollü ve tamper-evident hale geldi.
- Dashboard operatörü başarı/başarısızlık geçmişini ve chain hash referansını tek yerden görebiliyor.

### Bilinçli Olarak Ertelenenler
- Delivery retry queue / exponential backoff worker
- Public-key (asymmetric) signature + key rotation registry
- Çok hedefli scheduled export policies / per-destination secret negotiation
