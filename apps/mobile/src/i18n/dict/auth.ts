import type { Fragment } from '../fragment';

/**
 * Sign in, the temporary password, the Face ID lock, Settings and the language picker.
 * Each row: English, Uzbek (Latin), Russian, Spanish, Turkish, Kazakh.
 */
const ROWS: Array<[string, string, string, string, string, string]> = [
  // brand + login
  ['Trucking, on time. Every mile.', "Yuk tashish — o'z vaqtida. Har bir milda.", 'Грузоперевозки вовремя. Каждую милю.', 'Transporte a tiempo. Cada milla.', 'Zamanında taşımacılık. Her milde.', 'Жүк тасымалы — уақытында. Әр мильде.'],
  ['Welcome back', 'Xush kelibsiz', 'С возвращением', 'Bienvenido de nuevo', 'Tekrar hoş geldiniz', 'Қайта қош келдіңіз'],
  ['Sign in to your NeWay account', 'NeWay hisobingizga kiring', 'Войдите в свой аккаунт NeWay', 'Inicia sesión en tu cuenta de NeWay', 'NeWay hesabınıza giriş yapın', 'NeWay аккаунтыңызға кіріңіз'],
  ['Email or username', 'Email yoki login', 'Email или логин', 'Correo o usuario', 'E-posta veya kullanıcı adı', 'Email немесе логин'],
  ['Password', 'Parol', 'Пароль', 'Contraseña', 'Şifre', 'Құпиясөз'],
  ['Your password', 'Parolingiz', 'Ваш пароль', 'Tu contraseña', 'Şifreniz', 'Құпиясөзіңіз'],
  ['Hide password', 'Parolni yashirish', 'Скрыть пароль', 'Ocultar contraseña', 'Şifreyi gizle', 'Құпиясөзді жасыру'],
  ['Show password', "Parolni ko'rsatish", 'Показать пароль', 'Mostrar contraseña', 'Şifreyi göster', 'Құпиясөзді көрсету'],
  ['Keep me signed in', 'Tizimda qolish', 'Не выходить из аккаунта', 'Mantener la sesión iniciada', 'Oturumumu açık tut', 'Жүйеде қалу'],
  ['Log in', 'Kirish', 'Войти', 'Iniciar sesión', 'Giriş yap', 'Кіру'],
  ['Or continue with', 'Yoki davom eting', 'Или продолжите с', 'O continúa con', 'Ya da şununla devam edin', 'Немесе жалғастырыңыз'],
  ['Sign in with {label}', '{label} bilan kirish', 'Войти через {label}', 'Iniciar sesión con {label}', '{label} ile giriş yap', '{label} арқылы кіру'],
  ['Forgot your password? Ask your dispatcher or administrator to reset it.', "Parolni unutdingizmi? Dispetcher yoki administratordan uni tiklab berishni so'rang.", 'Забыли пароль? Попросите диспетчера или администратора сбросить его.', '¿Olvidaste tu contraseña? Pide a tu despachador o administrador que la restablezca.', 'Şifrenizi mi unuttunuz? Dispeçerinizden veya yöneticinizden sıfırlamasını isteyin.', 'Құпиясөзді ұмыттыңыз ба? Диспетчерден немесе әкімшіден оны қалпына келтіруді сұраңыз.'],
  ['Enter your email or username and your password.', 'Email yoki loginingiz va parolingizni kiriting.', 'Введите email или логин и пароль.', 'Escribe tu correo o usuario y tu contraseña.', 'E-postanızı veya kullanıcı adınızı ve şifrenizi girin.', 'Email немесе логин және құпиясөзді енгізіңіз.'],
  ['No connection. Signing in needs the internet.', "Aloqa yo'q. Kirish uchun internet kerak.", 'Нет связи. Для входа нужен интернет.', 'Sin conexión. Para iniciar sesión necesitas internet.', 'Bağlantı yok. Giriş için internet gerekir.', 'Байланыс жоқ. Кіру үшін интернет керек.'],
  ['That email or password is not right.', "Email yoki parol noto'g'ri.", 'Неверный email или пароль.', 'El correo o la contraseña no son correctos.', 'E-posta veya şifre yanlış.', 'Email немесе құпиясөз қате.'],
  ['Too many tries. Wait a minute and try again.', "Juda ko'p urinish. Bir daqiqa kutib, qayta urinib ko'ring.", 'Слишком много попыток. Подождите минуту и попробуйте снова.', 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.', 'Çok fazla deneme. Bir dakika bekleyip tekrar deneyin.', 'Тым көп әрекет. Бір минут күтіп, қайталап көріңіз.'],
  ['Could not sign in. Try again.', "Kirib bo'lmadi. Qayta urinib ko'ring.", 'Не удалось войти. Попробуйте снова.', 'No se pudo iniciar sesión. Inténtalo de nuevo.', 'Giriş yapılamadı. Tekrar deneyin.', 'Кіру мүмкін болмады. Қайталап көріңіз.'],
  ['Your session ended. Sign in again — anything waiting to upload is kept on this phone.', 'Seansingiz tugadi. Qayta kiring — yuklanishni kutayotgan hamma narsa shu telefonda saqlanadi.', 'Сеанс завершён. Войдите снова — всё, что ждёт отправки, сохранено на этом телефоне.', 'Tu sesión terminó. Vuelve a iniciar sesión: lo que espera subirse se guarda en este teléfono.', 'Oturumunuz sona erdi. Tekrar giriş yapın — yüklenmeyi bekleyenler bu telefonda saklanır.', 'Сеанс аяқталды. Қайта кіріңіз — жүктелуді күтіп тұрғанның бәрі осы телефонда сақталады.'],
  ['Turn on {label} for NeWay', 'NeWay uchun {label} ni yoqish', 'Включить {label} для NeWay', 'Activar {label} para NeWay', 'NeWay için {label} özelliğini aç', 'NeWay үшін {label} қосу'],
  ['Sign in to NeWay with {label}', 'NeWay ga {label} bilan kirish', 'Вход в NeWay через {label}', 'Inicia sesión en NeWay con {label}', 'NeWay’e {label} ile giriş yapın', 'NeWay-ге {label} арқылы кіру'],
  ['{label} did not recognise you. Use your password.', '{label} sizni tanimadi. Parolingizdan foydalaning.', '{label} не узнал вас. Войдите по паролю.', '{label} no te reconoció. Usa tu contraseña.', '{label} sizi tanımadı. Şifrenizi kullanın.', '{label} сізді танымады. Құпиясөзді пайдаланыңыз.'],
  ['Use {label} next time?', 'Keyingi safar {label} ishlatilsinmi?', 'Использовать {label} в следующий раз?', '¿Usar {label} la próxima vez?', 'Bir dahaki sefere {label} kullanılsın mı?', 'Келесі жолы {label} қолданылсын ба?'],
  ['Unlock NeWay with {label} instead of typing your password. Your password is never saved on the phone. You can change this in Settings.', "Parol yozish o'rniga NeWay ni {label} bilan oching. Parolingiz telefonda hech qachon saqlanmaydi. Buni Sozlamalarda o'zgartirishingiz mumkin.", 'Открывайте NeWay через {label} вместо ввода пароля. Пароль никогда не хранится на телефоне. Это можно изменить в Настройках.', 'Desbloquea NeWay con {label} en lugar de escribir tu contraseña. Tu contraseña nunca se guarda en el teléfono. Puedes cambiarlo en Ajustes.', 'Şifre yazmak yerine NeWay’i {label} ile açın. Şifreniz telefonda asla saklanmaz. Bunu Ayarlar’dan değiştirebilirsiniz.', 'Құпиясөз енгізудің орнына NeWay-ді {label} арқылы ашыңыз. Құпиясөз телефонда ешқашан сақталмайды. Мұны Баптауларда өзгертуге болады.'],
  ['Turn on {label}', '{label} ni yoqish', 'Включить {label}', 'Activar {label}', '{label} özelliğini aç', '{label} қосу'],
  ['Not now', 'Hozir emas', 'Не сейчас', 'Ahora no', 'Şimdi değil', 'Қазір емес'],
  ['Language: {name}', 'Til: {name}', 'Язык: {name}', 'Idioma: {name}', 'Dil: {name}', 'Тіл: {name}'],
  ['Language', 'Til', 'Язык', 'Idioma', 'Dil', 'Тіл'],

  // temporary password
  ['Choose your password', "O'z parolingizni tanlang", 'Придумайте пароль', 'Elige tu contraseña', 'Şifrenizi belirleyin', 'Құпиясөзіңізді таңдаңыз'],
  ['You signed in with a temporary password. Pick your own — at least {count} characters — to continue.', "Siz vaqtinchalik parol bilan kirdingiz. Davom etish uchun o'zingiznikini tanlang — kamida {count} ta belgi.", 'Вы вошли с временным паролем. Чтобы продолжить, придумайте свой — не короче {count} символов.', 'Iniciaste sesión con una contraseña temporal. Elige la tuya (al menos {count} caracteres) para continuar.', 'Geçici bir şifreyle giriş yaptınız. Devam etmek için kendi şifrenizi belirleyin — en az {count} karakter.', 'Сіз уақытша құпиясөзбен кірдіңіз. Жалғастыру үшін өз құпиясөзіңізді таңдаңыз — кемінде {count} таңба.'],
  ['Use at least {count} characters.', 'Kamida {count} ta belgi kiriting.', 'Используйте не менее {count} символов.', 'Usa al menos {count} caracteres.', 'En az {count} karakter kullanın.', 'Кемінде {count} таңба қолданыңыз.'],
  ['The two passwords do not match.', 'Ikki parol bir xil emas.', 'Пароли не совпадают.', 'Las dos contraseñas no coinciden.', 'İki şifre eşleşmiyor.', 'Екі құпиясөз сәйкес емес.'],
  ['Could not save the password.', 'Parolni saqlab bo‘lmadi.', 'Не удалось сохранить пароль.', 'No se pudo guardar la contraseña.', 'Şifre kaydedilemedi.', 'Құпиясөзді сақтау мүмкін болмады.'],
  ['New password', 'Yangi parol', 'Новый пароль', 'Nueva contraseña', 'Yeni şifre', 'Жаңа құпиясөз'],
  ['Repeat the new password', 'Yangi parolni takrorlang', 'Повторите новый пароль', 'Repite la nueva contraseña', 'Yeni şifreyi tekrarlayın', 'Жаңа құпиясөзді қайталаңыз'],
  ['Save password', 'Parolni saqlash', 'Сохранить пароль', 'Guardar contraseña', 'Şifreyi kaydet', 'Құпиясөзді сақтау'],
  ['Sign out', 'Chiqish', 'Выйти', 'Cerrar sesión', 'Çıkış yap', 'Шығу'],

  // Face ID lock and labels
  ['Face ID', 'Face ID', 'Face ID', 'Face ID', 'Face ID', 'Face ID'],
  ['Touch ID', 'Touch ID', 'Touch ID', 'Touch ID', 'Touch ID', 'Touch ID'],
  ['Face ID / fingerprint', 'Face ID / barmoq izi', 'Face ID / отпечаток пальца', 'Face ID / huella', 'Face ID / parmak izi', 'Face ID / саусақ ізі'],
  ['Face unlock', 'Yuz orqali ochish', 'Разблокировка по лицу', 'Desbloqueo facial', 'Yüz tanıma', 'Бетпен ашу'],
  ['Fingerprint', 'Barmoq izi', 'Отпечаток пальца', 'Huella digital', 'Parmak izi', 'Саусақ ізі'],
  ['Iris unlock', "Ko'z qorachig'i orqali ochish", 'Разблокировка по радужке', 'Desbloqueo por iris', 'İris ile kilit açma', 'Көз қарашығымен ашу'],
  ['Use password', 'Paroldan foydalanish', 'Ввести пароль', 'Usar contraseña', 'Şifre kullan', 'Құпиясөзді қолдану'],
  ['Looking for you…', 'Sizni tanimoqda…', 'Распознаём вас…', 'Buscándote…', 'Sizi tanıyor…', 'Сізді тануда…'],
  ['Unlock NeWay with {label}', 'NeWay ni {label} bilan ochish', 'Разблокировать NeWay через {label}', 'Desbloquea NeWay con {label}', 'NeWay’in kilidini {label} ile aç', 'NeWay-ді {label} арқылы ашу'],
  ['Not recognised. Try again or use your password.', "Tanilmadi. Qayta urinib ko'ring yoki paroldan foydalaning.", 'Не распознано. Попробуйте снова или войдите по паролю.', 'No se reconoció. Inténtalo de nuevo o usa tu contraseña.', 'Tanınmadı. Tekrar deneyin veya şifrenizi kullanın.', 'Танылмады. Қайталап көріңіз немесе құпиясөзді пайдаланыңыз.'],
  ['Try again', "Qayta urinish", 'Попробовать снова', 'Intentar de nuevo', 'Tekrar dene', 'Қайталау'],
  ['Cancel and use your password', 'Bekor qilib, paroldan foydalanish', 'Отменить и войти по паролю', 'Cancelar y usar tu contraseña', 'İptal et ve şifreni kullan', 'Бас тартып, құпиясөзді пайдалану'],
  ['Cancel', 'Bekor qilish', 'Отмена', 'Cancelar', 'İptal', 'Бас тарту'],

  // Settings
  ['Settings', 'Sozlamalar', 'Настройки', 'Ajustes', 'Ayarlar', 'Баптаулар'],
  ['make NeWay work your way', "NeWay ni o'zingizga moslang", 'настройте NeWay под себя', 'adapta NeWay a tu manera', 'NeWay’i kendinize göre ayarlayın', 'NeWay-ді өзіңізге бейімдеңіз'],
  ['Dark mode', 'Tungi rejim', 'Тёмная тема', 'Modo oscuro', 'Karanlık mod', 'Түнгі режим'],
  ['Following the phone', 'Telefon sozlamasiga mos', 'Как на телефоне', 'Según el teléfono', 'Telefona göre', 'Телефон бойынша'],
  ['Easy on the eyes at night', "Kechasi ko'zni charchatmaydi", 'Бережёт глаза ночью', 'Descansa la vista de noche', 'Gece gözü yormaz', 'Түнде көзді шаршатпайды'],
  ['Bright and clear in daylight', 'Kunduzi yorqin va aniq', 'Ярко и чётко днём', 'Brillante y claro de día', 'Gün ışığında parlak ve net', 'Күндіз жарық әрі анық'],
  ['PERSONALIZATION', 'SHAXSIY SOZLAMALAR', 'ПЕРСОНАЛИЗАЦИЯ', 'PERSONALIZACIÓN', 'KİŞİSELLEŞTİRME', 'ЖЕКЕ БАПТАУЛАР'],
  ['Appearance', "Ko'rinish", 'Оформление', 'Apariencia', 'Görünüm', 'Көрініс'],
  ['Light, Dark, or follow the phone', "Yorug', Tungi yoki telefonga mos", 'Светлая, тёмная или как на телефоне', 'Claro, oscuro o según el teléfono', 'Açık, Koyu veya telefona göre', 'Жарық, Түнгі немесе телефон бойынша'],
  ['Light', "Yorug'", 'Светлая', 'Claro', 'Açık', 'Жарық'],
  ['Dark', 'Tungi', 'Тёмная', 'Oscuro', 'Koyu', 'Түнгі'],
  ['System', 'Telefon', 'Системная', 'Sistema', 'Sistem', 'Жүйелік'],
  ['ALERTS', 'OGOHLANTIRISHLAR', 'ОПОВЕЩЕНИЯ', 'ALERTAS', 'UYARILAR', 'ЕСКЕРТУЛЕР'],
  ['Notifications', 'Bildirishnomalar', 'Уведомления', 'Notificaciones', 'Bildirimler', 'Хабарландырулар'],
  ['Push and sound on this phone', 'Shu telefondagi push va ovoz', 'Push и звук на этом телефоне', 'Push y sonido en este teléfono', 'Bu telefonda bildirim ve ses', 'Осы телефондағы push және дыбыс'],
  ['PRIVACY & SECURITY', 'MAXFIYLIK VA XAVFSIZLIK', 'КОНФИДЕНЦИАЛЬНОСТЬ И БЕЗОПАСНОСТЬ', 'PRIVACIDAD Y SEGURIDAD', 'GİZLİLİK VE GÜVENLİK', 'ҚҰПИЯЛЫҚ ЖӘНЕ ҚАУІПСІЗДІК'],
  ['Not set up on this phone (or not available in this app build)', "Bu telefonda sozlanmagan (yoki ilovaning bu versiyasida yo'q)", 'Не настроено на этом телефоне (или недоступно в этой сборке)', 'No configurado en este teléfono (o no disponible en esta versión)', 'Bu telefonda ayarlı değil (veya bu sürümde yok)', 'Бұл телефонда бапталмаған (немесе бұл нұсқада жоқ)'],
  ['Needs "Keep me signed in" at your next sign-in', 'Keyingi kirishda "Tizimda qolish" belgilansin', 'При следующем входе отметьте «Не выходить из аккаунта»', 'Marca "Mantener la sesión iniciada" la próxima vez', 'Bir sonraki girişte "Oturumumu açık tut" seçilmeli', 'Келесі кіргенде «Жүйеде қалу» белгіленуі керек'],
  ['Unlock NeWay without typing your password', 'NeWay ni parol yozmasdan ochish', 'Открывайте NeWay без ввода пароля', 'Desbloquea NeWay sin escribir tu contraseña', 'NeWay’i şifre yazmadan açın', 'NeWay-ді құпиясөзсіз ашу'],
  ['Your data', "Ma'lumotlaringiz", 'Ваши данные', 'Tus datos', 'Verileriniz', 'Деректеріңіз'],
  ['NeWay shows you only your own loads and pay. Your password is never stored on the phone.', "NeWay sizga faqat o'z yuklaringiz va maoshingizni ko'rsatadi. Parolingiz telefonda hech qachon saqlanmaydi.", 'NeWay показывает только ваши грузы и выплаты. Пароль никогда не хранится на телефоне.', 'NeWay solo te muestra tus cargas y tu pago. Tu contraseña nunca se guarda en el teléfono.', 'NeWay size yalnızca kendi yüklerinizi ve ödemenizi gösterir. Şifreniz telefonda asla saklanmaz.', 'NeWay сізге тек өз жүктеріңіз бен төлеміңізді көрсетеді. Құпиясөз телефонда ешқашан сақталмайды.'],
  ['ACCOUNT', 'HISOB', 'АККАУНТ', 'CUENTA', 'HESAP', 'АККАУНТ'],
  ['Removes your drafts and waiting uploads from this phone', "Qoralamalar va yuklanishni kutayotgan fayllar shu telefondan o'chiriladi", 'Удаляет черновики и ожидающие отправки файлы с этого телефона', 'Borra tus borradores y lo que espera subirse en este teléfono', 'Taslaklarınızı ve bekleyen yüklemeleri bu telefondan siler', 'Осы телефондағы жобалар мен күтіп тұрған жүктемелерді өшіреді'],
  ['Saved on this phone; the profile will update when you are online.', 'Shu telefonda saqlandi; internet bo‘lganda profil yangilanadi.', 'Сохранено на телефоне; профиль обновится, когда появится связь.', 'Guardado en este teléfono; el perfil se actualizará cuando tengas conexión.', 'Bu telefonda kaydedildi; çevrimiçi olduğunuzda profil güncellenecek.', 'Осы телефонда сақталды; желіге қосылғанда профиль жаңарады.'],
  ['{label} was not turned on.', '{label} yoqilmadi.', '{label} не включён.', '{label} no se activó.', '{label} açılmadı.', '{label} қосылмады.'],
  ['Settings saved', 'Sozlamalar saqlandi', 'Настройки сохранены', 'Ajustes guardados', 'Ayarlar kaydedildi', 'Баптаулар сақталды'],
  ['{count} change', "{count} ta o'zgarish", '{count} изменение', '{count} cambio', '{count} değişiklik', '{count} өзгеріс'],
  ['{count} changes', "{count} ta o'zgarish", 'Изменений: {count}', '{count} cambios', '{count} değişiklik', '{count} өзгеріс'],
  ['Discard', 'Bekor qilish', 'Отменить', 'Descartar', 'Vazgeç', 'Бас тарту'],
  ['Save', 'Saqlash', 'Сохранить', 'Guardar', 'Kaydet', 'Сақтау'],
  ['Saving…', 'Saqlanmoqda…', 'Сохранение…', 'Guardando…', 'Kaydediliyor…', 'Сақталуда…'],
  ['This is how NeWay talks to you.', 'NeWay siz bilan shu tilda gaplashadi.', 'Так NeWay будет говорить с вами.', 'Así te hablará NeWay.', 'NeWay sizinle böyle konuşur.', 'NeWay сізбен осылай сөйлеседі.'],
  ['The change applies at once and is kept on this phone. Ask NeWay answers in the language you write in.', "O'zgarish darhol qo'llanadi va shu telefonda saqlanadi. Ask NeWay siz yozgan tilda javob beradi.", 'Изменение применяется сразу и сохраняется на этом телефоне. Ask NeWay отвечает на языке, на котором вы пишете.', 'El cambio se aplica al instante y se guarda en este teléfono. Ask NeWay responde en el idioma en que escribes.', 'Değişiklik hemen uygulanır ve bu telefonda saklanır. Ask NeWay, yazdığınız dilde yanıt verir.', 'Өзгеріс бірден қолданылып, осы телефонда сақталады. Ask NeWay сіз жазған тілде жауап береді.'],

  // notifications page
  ['Push needs the installed NeWay app. Expo Go and the web preview cannot receive it; the bell inside the app still shows everything.', "Push uchun o'rnatilgan NeWay ilovasi kerak. Expo Go va veb-ko'rinish uni qabul qila olmaydi; ilova ichidagi qo'ng'iroqcha baribir hammasini ko'rsatadi.", 'Для push нужно установленное приложение NeWay. Expo Go и веб-версия их не получают; колокольчик в приложении всё равно показывает всё.', 'Las notificaciones push necesitan la app NeWay instalada. Expo Go y la vista web no las reciben; la campana de la app sigue mostrando todo.', 'Anlık bildirimler için yüklü NeWay uygulaması gerekir. Expo Go ve web önizlemesi bunları alamaz; uygulamadaki zil yine her şeyi gösterir.', 'Push үшін орнатылған NeWay қолданбасы керек. Expo Go мен веб-нұсқа оны қабылдай алмайды; қолданбадағы қоңырау бәрібір бәрін көрсетеді.'],
  ['THIS PHONE', 'SHU TELEFON', 'ЭТОТ ТЕЛЕФОН', 'ESTE TELÉFONO', 'BU TELEFON', 'ОСЫ ТЕЛЕФОН'],
  ['Push notifications', 'Push-bildirishnomalar', 'Push-уведомления', 'Notificaciones push', 'Anlık bildirimler', 'Push-хабарландырулар'],
  ['Loads, documents, pay and messages from the office', 'Ofisdan yuklar, hujjatlar, maosh va xabarlar', 'Грузы, документы, выплаты и сообщения из офиса', 'Cargas, documentos, pagos y mensajes de la oficina', 'Ofisten yükler, belgeler, ödeme ve mesajlar', 'Кеңседен жүктер, құжаттар, төлем және хабарлар'],
  ['Sound while the app is open', 'Ilova ochiq paytda ovoz', 'Звук, когда приложение открыто', 'Sonido con la app abierta', 'Uygulama açıkken ses', 'Қолданба ашық кезде дыбыс'],
  ['On this phone only', 'Faqat shu telefonda', 'Только на этом телефоне', 'Solo en este teléfono', 'Yalnızca bu telefonda', 'Тек осы телефонда'],
  ['IN THE APP', 'ILOVADA', 'В ПРИЛОЖЕНИИ', 'EN LA APP', 'UYGULAMADA', 'ҚОЛДАНБАДА'],
  ['Notification bell', "Bildirishnoma qo'ng'iroqchasi", 'Колокольчик уведомлений', 'Campana de notificaciones', 'Bildirim zili', 'Хабарландыру қоңырауы'],
  ['Always on: every notification the TMS sends you', 'Doim yoqiq: TMS yuborgan har bir bildirishnoma', 'Всегда включён: все уведомления, которые присылает TMS', 'Siempre activa: cada notificación que te envía el TMS', 'Her zaman açık: TMS’in gönderdiği her bildirim', 'Әрқашан қосулы: TMS жіберген әр хабарландыру'],
];

const fragment: Fragment = { uz: {}, ru: {}, es: {}, tr: {}, kk: {} };
for (const [en, uz, ru, es, tr, kk] of ROWS) {
  fragment.uz[en] = uz;
  fragment.ru[en] = ru;
  fragment.es[en] = es;
  fragment.tr[en] = tr;
  fragment.kk[en] = kk;
}

export default fragment;
