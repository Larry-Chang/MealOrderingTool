/**
 * ==========================================
 * 系統設定區 (請填寫您的 API 憑證與試算表 ID)
 * ==========================================
 */
const CLIENT_ID = '355179473559-m83vpsjsucrv25n31quqrgddt91m13m9.apps.googleusercontent.com';
const API_KEY = 'AIzaSyBtkulfTTbIdWXyli1Z0RRuTsERKdxcXH0';
const SPREADSHEET_ID = '1lxCQpdRS0sAxlaA5XREPHPCPo7puVuYvrZI63qLpVFc';

// Google API Scopes 所需權限：試算表讀寫權限 與 使用者 Email 資訊
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';
const DISCOVERY_DOCS = ['https://sheets.googleapis.com/$discovery/rest?version=v4'];

/**
 * ==========================================
 * 全域狀態變數
 * ==========================================
 */
let tokenClient;         // Google 認證 Token 客戶端
let currentUser = {      // 目前登入者資訊
    email: '',
    name: '',
    role: ''             // '管理員' 或 '一般成員'
};
let allUsers = [];       // 快取所有使用者名單 (輔助查詢姓名使用)
let rawMenuData = [];    // 取得的完整菜單
let todayRestaurants = []; // 今日有開放的餐廳
let salesChartInstance = null; // Chart.js 圖表實例


/**
 * ==========================================
 * 初始化與登入邏輯
 * ==========================================
 */
window.onload = function () {
    gapiInit();
    gisInit();
    setupEventListeners();
};

// 1. 初始化 Google API Client (用於操作表單 API)
function gapiInit() {
    gapi.load('client', async () => {
        await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: DISCOVERY_DOCS,
        }).catch(err => {
            console.error('GAPI Client 載入錯誤:', err);
            document.getElementById('login-status').innerText = 'API 初始化失敗，請檢查金鑰設定。';
        });
    });
}

// 2. 初始化 Google Identity Services Token Client (用於登入取得 Token)
function gisInit() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (tokenResponse) => {
            if (tokenResponse.error !== undefined) {
                showToast('登入取消或發生錯誤');
                throw (tokenResponse);
            }
            // 登入成功後，利用 access token 向 Google 取得 Email 資訊
            await fetchUserProfile(tokenResponse.access_token);
        },
    });
}

// 點擊「Google 帳號登入」按鈕
function handleAuthClick() {
    document.getElementById('login-status').innerText = '處理中...';
    // 若尚未取得 Token，則彈出授權視窗
    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

// 取得使用者 Email 並進行試算表授權驗證
async function fetchUserProfile(accessToken) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await response.json();
        const email = data.email;

        await checkUserPermission(email);
    } catch (err) {
        showToast('取得使用者資訊失敗');
        console.error(err);
        document.getElementById('login-status').innerText = '無法讀取帳號資訊，請重試。';
    }
}

// 比對 Users 工作表檢查權限
async function checkUserPermission(email) {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:C',
        });
        const rows = response.result.values;
        if (!rows || rows.length === 0) {
            showToast('找不到 Users 資料表');
            return;
        }

        allUsers = []; // 清空並重新儲存以供後續對照
        let foundUser = null;

        // 走訪所有行以比對 (忽略第 0 列的標題)
        for (let i = 1; i < rows.length; i++) {
            const userName = rows[i][0] || '';
            const userEmail = rows[i][1] || '';
            const userRole = rows[i][2] || '';

            allUsers.push({ name: userName, email: userEmail, role: userRole });

            if (userEmail === email) {
                foundUser = { name: userName, email: userEmail, role: userRole };
            }
        }

        if (foundUser) {
            currentUser = foundUser;
            initApp(); // 通過授權，啟動應用
        } else {
            showToast('未獲授權：您的 Email 不在系統名單內');
            document.getElementById('login-status').innerText = `帳號無權限 (${email})，請聯絡管理員。`;
        }
    } catch (err) {
        showToast('權限檢查失敗，請確認 API 設定與試算表 ID');
        console.error('權限檢查錯誤:', err);
    }
}

// 輔助函式：透過 Email 查使用者姓名
function getUserNameByEmail(email) {
    const user = allUsers.find(u => u.email === email);
    return user ? user.name : (email ? email.split('@')[0] : '未知');
}

/**
 * ==========================================
 * 應用進場初始化
 * ==========================================
 */
async function initApp() {
    // 切換隱藏/顯示區塊
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');

    // UI 文字顯示
    document.getElementById('user-name-display').innerText = currentUser.name;
    document.getElementById('user-role-display').innerText = currentUser.role;

    // 若為管理員，開啟管理員專區頁籤
    if (currentUser.role === '管理員') {
        document.getElementById('admin-tab-btn').classList.remove('hidden');
    } else {
        document.getElementById('admin-tab-btn').classList.add('hidden');
    }

    // 載入必要資料 (不阻塞 UI，並行取得也可以，但依序較不易出錯)
    await loadTodayConfig();
    await loadMenu();
    await loadOrders();

    // 生成並渲染介面
    renderMenu();
    renderOrders();
    if (currentUser.role === '管理員') {
        renderAdminCheckboxes();
    }
}

/**
 * ==========================================
 * 資料讀取介接
 * ==========================================
 */
// 讀取 TodayConfig (今日開放餐廳)
async function loadTodayConfig() {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'TodayConfig!A:A',
        });
        const rows = response.result.values;
        todayRestaurants = [];
        // [0] 是標題 "今日開放餐廳"
        if (rows && rows.length > 1) {
            for (let i = 1; i < rows.length; i++) {
                if (rows[i][0]) todayRestaurants.push(rows[i][0]);
            }
        }
        document.getElementById('today-restaurants-display').innerText =
            todayRestaurants.length > 0 ? todayRestaurants.join('、') : '尚未設定';
    } catch (err) {
        console.error('讀取 TodayConfig 失敗', err);
    }
}

// 讀取 Menu (完整菜單)
async function loadMenu() {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Menu!A:D',
        });
        const rows = response.result.values;
        rawMenuData = [];
        if (rows && rows.length > 1) {
            for (let i = 1; i < rows.length; i++) {
                rawMenuData.push({
                    restaurant: rows[i][0] || '',
                    name: rows[i][1] || '',
                    price: rows[i][2] || '',
                    category: rows[i][3] || ''
                });
            }
        }
    } catch (err) {
        console.error('讀取 Menu 失敗', err);
    }
}

// 讀取 Orders (今日訂單)
async function loadOrders() {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:F',
        });
        // 存放於全域變數以利渲染及匯出功能
        window.currentOrders = response.result.values || [];
        renderOrders();
    } catch (err) {
        console.error('讀取 Orders 失敗', err);
    }
}


/**
 * ==========================================
 * 管理員專屬功能：設定餐廳與清空訂單
 * ==========================================
 */
function renderAdminCheckboxes() {
    // 找出 Menu 中所有不重複的餐廳
    const uniqueRestaurants = [...new Set(rawMenuData.map(item => item.restaurant))].filter(Boolean);
    const container = document.getElementById('restaurant-checkboxes');
    container.innerHTML = '';

    uniqueRestaurants.forEach(restaurant => {
        const isChecked = todayRestaurants.includes(restaurant);
        const label = document.createElement('label');
        label.className = 'checkbox-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = restaurant;
        checkbox.checked = isChecked;

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(restaurant));
        container.appendChild(label);
    });
}

// 將勾選的餐廳寫入 TodayConfig
async function saveTodayRestaurants() {
    const checkboxes = document.querySelectorAll('#restaurant-checkboxes input[type="checkbox"]:checked');
    const selected = Array.from(checkboxes).map(cb => [cb.value]);

    // 首列為標題
    const writeData = [['今日開放餐廳'], ...selected];

    try {
        // 先清除 A 欄全部資料
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: 'TodayConfig!A:A'
        });

        // 取代成新的資料
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: 'TodayConfig!A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: writeData }
        });

        showToast('✅ 今日餐廳已成功更新！');
        await loadTodayConfig(); // 重新讀取
        renderMenu();            // 重新顯示菜單
    } catch (err) {
        console.error(err);
        showToast('❌ 儲存失敗');
    }
}

// 刪除除了標題列之外的所有點餐紀錄
async function clearOrders() {
    if (!confirm('⚠️ 警告：確定要清空所有的點餐紀錄嗎？（此動作無法復原）')) return;

    try {
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A2:Z'
        });

        showToast('🗑️ 訂單已全數清空！');
        await loadOrders();
    } catch (err) {
        console.error(err);
        showToast('❌ 清空訂單失敗');
    }
}


/**
 * ==========================================
 * 點餐功能邏輯
 * ==========================================
 */
// 根據 TodayConfig 過濾餐點並顯示卡片
function renderMenu() {
    const container = document.getElementById('menu-container');
    container.innerHTML = '';

    if (todayRestaurants.length === 0) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--text-light);">今日尚未開放任何餐廳，請稍後再來或聯絡管理員設定。</p>';
        return;
    }

    // 只保留今日餐廳的菜單項目
    const availableItems = rawMenuData.filter(item => todayRestaurants.includes(item.restaurant));

    availableItems.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'menu-card';

        card.innerHTML = `
            <span class="restaurant-badge">${item.restaurant}</span>
            <h3>${item.name}</h3>
            <div class="price">$${item.price}</div>
            <input type="text" id="note-${index}" placeholder="備註 (如：不要蔥、微糖去冰...)">
            <button class="primary-btn mt-auto" onclick="submitOrder('${item.restaurant}', '${item.name}', '${item.price}', ${index})">點餐</button>
        `;
        container.appendChild(card);
    });
}

// 寫入一筆資料至 Orders 表
async function submitOrder(restaurant, itemName, price, index) {
    const noteInput = document.getElementById(`note-${index}`).value.trim();

    // 產生格式化日期 yyyy/MM/dd HH:mm
    const now = new Date();
    const timeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 格式必須遵守：[點餐時間, 訂購人 Email, 餐廳名稱, 餐點內容, 金額, 備註]
    const rowData = [
        timeStr,
        currentUser.email,
        restaurant,
        itemName,
        price,
        noteInput
    ];

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:F',
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: { values: [rowData] }
        });

        // 點餐成功後 UI 回饋
        document.getElementById(`note-${index}`).value = '';
        showToast(`✅ 成功點選：${itemName}`);

        // 更新訂單表不阻塞當前流暢度，在背景重抓
        loadOrders();
    } catch (err) {
        console.error('點餐寫入失敗', err);
        showToast('❌ 點餐失敗，請重試或確認網路狀態');
    }
}


/**
 * ==========================================
 * 訂單列表顯示與複製
 * ==========================================
 */
function renderOrders() {
    const tbody = document.getElementById('orders-tbody');
    tbody.innerHTML = '';

    const orders = window.currentOrders || [];

    // 若無資料或是只有第一列標題，則提示無資料
    if (orders.length <= 1) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-light);">目前尚未有任何人點餐</td></tr>';
        return;
    }

    // 從第一筆資料 (索引 1) 開始畫 (避開標題)
    for (let i = 1; i < orders.length; i++) {
        const row = orders[i];
        const tr = document.createElement('tr');

        // 利用先前的 allUsers 快取，將 Email 轉換為姓名
        const ordererEmail = row[1] || '';
        const ordererName = getUserNameByEmail(ordererEmail);

        tr.innerHTML = `
            <td>${row[0] || ''}</td>
            <td>${ordererName}</td>
            <td>${row[2] || ''}</td>
            <td>${row[3] || ''}</td>
            <td>${row[4] || ''}</td>
            <td>${row[5] || ''}</td>
        `;
        tbody.appendChild(tr);
    }
    
    // 渲染營業額統計圖表
    renderSalesChart();
}

// 渲染圖表函式
function renderSalesChart() {
    const orders = window.currentOrders || [];
    const salesData = {};

    // 先初始化「今日有開放的餐廳」，預設營業額為 0
    todayRestaurants.forEach(rest => {
        salesData[rest] = 0;
    });

    // 累加訂單金額
    if (orders.length > 1) {
        for (let i = 1; i < orders.length; i++) {
            const row = orders[i];
            const restaurant = row[2];
            const price = parseInt(row[4], 10) || 0;
            
            if (!restaurant) continue;

            if (salesData[restaurant] !== undefined) {
                salesData[restaurant] += price;
            } else {
                salesData[restaurant] = price; 
            }
        }
    }

    const labels = Object.keys(salesData);
    const data = Object.values(salesData);

    const ctx = document.getElementById('salesChart');
    if (!ctx) return;

    // 若圖表已存在，需要先銷毀才能重新繪製
    if (salesChartInstance) {
        salesChartInstance.destroy();
    }

    salesChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'bar', // 長條圖
        data: {
            labels: labels,
            datasets: [{
                label: '營業額 (元)',
                data: data,
                backgroundColor: 'rgba(43, 108, 176, 0.7)',
                borderColor: 'rgba(43, 108, 176, 1)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true
                }
            },
            plugins: {
                legend: {
                    display: false // 隱藏圖例，因為只有單一資料維度
                },
                title: {
                    display: true,
                    text: '今日商家營業額統計',
                    font: {
                        size: 16,
                        family: "'Helvetica Neue', '微軟正黑體', sans-serif"
                    }
                }
            }
        }
    });
}

// 產生友善的純文本，複製以利於 LINE 或 Slack 確認對帳
function copyOrdersToClipboard() {
    const orders = window.currentOrders || [];
    if (orders.length <= 1) {
        showToast('目前沒有訂單可以複製');
        return;
    }

    let textToCopy = '🍽️ 今日點餐明細匯總 🍽️\n';

    // 依據餐廳進行群組化
    const groupedOrders = {};
    let totalAmount = 0;

    for (let i = 1; i < orders.length; i++) {
        const row = orders[i];
        const restaurant = row[2] || '未知餐廳';
        const itemName = row[3] || '';
        const price = parseInt(row[4], 10) || 0;
        const note = row[5] ? ` (${row[5]})` : '';
        const ordererName = getUserNameByEmail(row[1]);

        if (!groupedOrders[restaurant]) groupedOrders[restaurant] = [];

        // 格式：- 品名 $單價 (備註) [點餐人]
        groupedOrders[restaurant].push(`- ${itemName} $${price}${note} [${ordererName}]`);
        totalAmount += price;
    }

    // 將各群組轉化為文字
    for (const [rest, items] of Object.entries(groupedOrders)) {
        textToCopy += `\n【${rest}】\n` + items.join('\n') + '\n';
    }

    textToCopy += `\n💰 總計金額：$${totalAmount}`;

    // 呼叫剪貼簿 API
    navigator.clipboard.writeText(textToCopy).then(() => {
        showToast('✅ 訂單文字已複製到剪貼簿！可直接貼在 LINE');
    }).catch(err => {
        console.error('複製失敗', err);
        showToast('❌ 複製失敗，您的瀏覽器可能不支援');
    });
}


/**
 * ==========================================
 * DOM 事件綁定與共用工具
 * ==========================================
 */
function setupEventListeners() {
    // 登入
    document.getElementById('auth-btn').addEventListener('click', handleAuthClick);

    // 登出
    document.getElementById('logout-btn').addEventListener('click', () => {
        const token = gapi.client.getToken();
        if (token !== null) {
            google.accounts.oauth2.revoke(token.access_token, () => {
                gapi.client.setToken('');
                location.reload(); // 重新整理頁面清除狀態
            });
        }
    });

    // 頁籤切換
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // 切換至「訂單頁籤」時，拉取最新狀態避免不同步
            if (e.target.dataset.target === 'list-tab') {
                loadOrders();
            }

            // 移除所有 active 狀態
            tabBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

            // 啟用當前選中標籤與內容
            e.target.classList.add('active');
            const targetId = e.target.dataset.target;
            document.getElementById(targetId).classList.remove('hidden');
        });
    });

    // 管理員設定今日餐廳
    const saveBtn = document.getElementById('save-today-restaurants');
    if (saveBtn) saveBtn.addEventListener('click', saveTodayRestaurants);

    // 管理員清空訂單
    const clearBtn = document.getElementById('clear-orders-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearOrders);

    // 一鍵複製訂單按鈕
    const copyBtn = document.getElementById('copy-orders-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyOrdersToClipboard);
}

// 畫面下方 Toast 短暫提示訊息顯示
function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.classList.remove('hidden');

    // 若已經有設定計時器，先取消以避免衝突
    if (window.toastTimeout) clearTimeout(window.toastTimeout);

    window.toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3500);
}
