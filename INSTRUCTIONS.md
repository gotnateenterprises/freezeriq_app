# 🛠️ Fix Instructions (Windows Safe Mode)

It looks like PowerShell is blocking standard commands. Please copy and run these commands **exactly as written** (one line at a time).

## 1. Install Dependencies
(This uses `cmd /c` to bypass PowerShell restrictions)

```powershell
cmd /c "npm install"
```

## 2. Rebuild Database Client

```powershell
cmd /c "npx prisma generate"
```

## 3. Run the Import

```powershell
cmd /c "npx tsx scripts/seed_from_csv.ts"
```

---
**Note:** Do not copy the backticks ` ``` ` or `powershell` text. Just copy the command itself (e.g. `cmd /c "npm install"`).
