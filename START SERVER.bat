@echo off
cd /d E:\MotorStock
node server.js
pause
```
6. Save (`Ctrl + S`) → close Notepad

From now on, **double-click `START SERVER.bat`** every morning to start the server. A black window will appear showing the server is running — **don't close that window.**

---

## STEP 7 — Allow through Windows Firewall (so other PCs can connect)

1. Press `Win + S` → type **Windows Defender Firewall** → open it
2. On the left panel click **"Advanced Settings"**
3. A new window opens — click **"Inbound Rules"** on the left
4. On the right panel click **"New Rule..."**
5. Select **Port** → click Next
6. Select **TCP**, in the box type `8080` → click Next
7. Select **Allow the connection** → click Next
8. Leave all three boxes ticked → click Next
9. In the Name field type `MotorStock` → click **Finish**

---

## STEP 8 — Open the dashboard

1. Double-click **`START SERVER.bat`** — black window appears, keep it open
2. Open your browser (Chrome/Edge)
3. In the address bar type:
```
http://localhost:8080/motor-stock-dashboard.html
```
4. Your dashboard opens 🎉

---

## STEP 9 — Let other office PCs connect

1. While the server is running, look at the black window — it shows a line like:
```
📡  Network:  http://192.168.1.10:8080
```
2. On any other PC in the office, open a browser and type that exact address:
```
http://192.168.1.10:8080/motor-stock-dashboard.html