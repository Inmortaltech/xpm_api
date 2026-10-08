# PMO Section — Backend

PMO sidebar ke saare pages ab local backend (`xmp_Ai`) se connected hain.

## DB setup

```bash
mysql -u root xmp_db < db_bkp/xmp_db_pmo_module.sql
```
Naye tables: `project_status`, `resource_change_requests`.

## PMO sidebar — page ↔ endpoint map

| Sidebar page | Endpoints | Status |
|---|---|---|
| **Dashboard** | `GET /api/admin/all_projects` | ✅ pehle se connected |
| **All Projects** | `GET /api/admin/get_projectList`, `POST /api/projectManager/get_projectsByPm` | ✅ |
| **Project Allocation** (Create Project) | `USER_LIST`, `GET_PROJECT_LIST`, `CREATE_PROJECT_API`, `ADD_PROJECT`, `UPDATE_PROJECT`, `re-allocated` | ✅ |
| → **Denied PM History** modal | `GET /api/projectManager/denied_pm_history` | ✅ **ab connected** (pehle MOCK_HISTORY tha) |
| **PMO Review** | `POST /api/admin/getProjectsStatus`, `POST /api/projectManager/scheduleStatusByPm`, `GET_PROJECT_LIST`, `POST /api/projectManager/get_project_schedule` | ✅ **ab connected** |
| **Change Requests** (list) | `GET /api/admin/resource_change_requests` | ✅ **ab connected** (pehle 100% localStorage) |
| **Resource Approval Queue** | list + `approve_resource_change` / `reject_resource_change` / `clarify_resource_change` | ✅ **ab connected** |
| **Resource Change Request Detail** | `GET /api/admin/resource_change_request_detail?id=` + approve/reject/clarify | ✅ **ab connected** |
| **Workload** | `RESOURCE_LIST` + `GET_PROJECT_LIST` (client-side calc) | ✅ pehle se |
| **Resource Master** | `CREATE_RESOURCE` / `UPDATE_RESOURCE` / `RESOURCE_LIST` / `DEACTIVATE_RESOURCE` | ✅ pehle se |
| **Resource Allocation** | `GET_PROJECT_LIST` | ✅ pehle se |
| **Calendar** | `HOLIDAYS` / `ADD_HOLIDAY` / `DELETE_HOLIDAY` | ✅ pehle se |

## Naye endpoints (detail)

### PMO Review workflow
| Method | Path | Body | Return |
|---|---|---|---|
| POST | `/api/admin/getProjectsStatus` | `{ pmo_id }` \| `{ pm_id }` | `{ success, data: [ { id, project_name, pm_status, pmo_status, reason, schedule_data, ... } ] }` |
| POST | `/api/projectManager/scheduleStatusByPm` | PM: `{ project_id, pm_id, pm_status, reason, pmo_id?, pmo_status?, schedule_data? }` · PMO: `{ project_id, pmo_id, pmo_status, reason }` | `{ success }` |

`pm_status`: `draft` \| `frozen` — `pmo_status`: `pending` \| `approved` \| `rejected`.
PMO `approved` hone par project `status = 'Active'` bhi set ho jata hai.

### Resource Change Requests
| Method | Path | Body |
|---|---|---|
| GET | `/api/admin/resource_change_requests` | — |
| GET | `/api/admin/resource_change_request_detail` | `?id=RCR-xxxx` |
| POST | `/api/admin/approve_resource_change` | `{ id, notes }` |
| POST | `/api/admin/reject_resource_change` | `{ id, reason }` |
| POST | `/api/admin/clarify_resource_change` | `{ id, query }` |
| POST | `/api/projectManager/create_resource_change_request` | `{ projectId, projectName, projectManager, pm_id, reasonProvidedByPM, currentAllocation[], requestedAllocation[], ... }` |

Pura request object `resource_change_requests.payload` (JSON) me store hota hai — frontend
ka data layer (`src/data/resourceChangeRequestsData.js`) usi shape ko padhta hai.
Approve/Reject/Clarify server-side `payload.activityLog` me entry append karte hain aur
`status` update karte hain.

## Frontend changes (WorKXKloud @ djwork_v2)

- `src/config/api.js` → `DENIED_PM_HISTORY` add
- `src/data/resourceChangeRequestsData.js`:
  - mock seeding hataya — ab empty cache = "kuch nahi"
  - naya `syncResourceChangeRequests()` — backend se list laa ke localStorage cache refresh + event dispatch
  - `approve/reject/clarify` → local optimistic update + backend POST (best-effort) + re-sync
  - `createResourceChangeRequest` → real backend POST + re-sync
- `ResourceChangeRequestsListPage` / `ResourceApprovalQueuePage` / `ResourceChangeRequestDetailPage` → mount par `syncResourceChangeRequests()` call
- `CreateProjectPage` → Denied PM History modal ab `DENIED_PM_HISTORY` fetch karta hai (MOCK_HISTORY delete)

## Pattern

Resource Change Requests **offline-first** hai: localStorage cache instant UI deta hai,
backend authoritative hai. Har mount + har mutation par cache backend se re-sync hota hai.
Notifications / Risk ke jaisa hi pattern.
