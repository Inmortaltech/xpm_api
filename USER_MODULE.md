# User / Resource Section — Backend

Ye module **djwork_v2** client ke "user" (resource / tester / developer) section ke
saare pages ko local backend (`xmp_Ai`, port 8021) se connect karta hai.

Frontend pages:
- `src/pages/MyTasksPage.jsx`               — "For You" (mere saare projects)
- `src/pages/MyTaskProjectDetailPage.jsx`   — Summary / List / Project Status / Board / Discussions
- `src/pages/RiskPage.jsx`                   — Risk register
- `src/components/notifications/*`           — bell icon panel
- `src/components/projects/ProjectBoardSection.jsx`
- `src/components/projects/ProjectDiscussionSection.jsx`

## 1. Database setup

```bash
# pehle (agar nahi chalaya): PM/PMO module
mysql -u root xmp_db < db_bkp/xmp_db_pm_pmo_module.sql
# phir: user module
mysql -u root xmp_db < db_bkp/xmp_db_user_module.sql
```

Naye tables: `project_schedule`, `boards` (reshaped: `task_id`, `due_date`, `attachments`),
`board_status`, `notifications`, `risks`, `project_discussions`.
Controllers pehli request par ye tables khud bhi bana lete hain (`ensureSchema`), lekin
SQL file me indexes + demo seed data bhi hai.

## 2. Endpoints

### `/api/users`
| Method | Path | Body | Frontend |
|---|---|---|---|
| POST | `/get_userProjectList` | `{ resource }` | MyTasks + Project Detail + Risk (data source) |
| POST | `/create_board` | `{ project_id, task_id, status, resource_id, pm_id }` | Board — add card |
| POST | `/editBoard` | `{ id, ...fields }` (JSON ya multipart `attachments`) | Board — edit / move |
| POST | `/deleteBoard` | `{ id }` | Board — delete |
| POST | `/get_userDiscussion` | FormData `resource_id, type` | Discussions tab |
| POST | `/create_discussion` | FormData | (helper) |
| GET | `/get_notifications` | `?user_id` | Bell panel |
| POST | `/mark_notification_read` | `{ id }` | |
| POST | `/mark_all_notifications_read` | `{ user_id? }` | |
| DELETE/POST | `/clear_all_notifications` | `{ user_id? }` | |
| POST | `/delete_notification` | `{ id }` | |
| GET | `/get_risks` | `?project_id&resource_id` | RiskPage |
| POST | `/create_risk` | `{ project_id, task_name, due_date, state, impact, probability, resource_id }` | |
| POST | `/update_risk` | `{ id, ...fields }` | |
| POST | `/delete_risk` | `{ id }` \| `{ ids: [] }` | RiskPage bulk delete |

### `/api/projectManager` (board read side — "Board" tab)
| Method | Path | Body |
|---|---|---|
| POST | `/getBoard` | `{ pm_id, project_id }` → `{ data: { in_discussion, to_do, in_work, in_progress, completed } }` |
| POST | `/get_project_schedule` | `{ project_id, pm_id }` → `{ data: [ { id, task_name, ... } ] }` |
| POST/GET | `/getBoardStatus` | `{ project_id }` |
| POST | `/saveBoardStatus` | `{ project_id, pm_id, status_name }` ya `{ ..., statuses: [] }` |
| POST | `/editBoardStatus` | `{ id, status_name, wip_limit?, sort_order? }` |
| POST | `/deleteBoardStatus` | `{ id }` |

## 3. Data model notes

- **`project_schedule`** ek hi table me task (`parent_id IS NULL`, `type='project'`) aur
  subtask (`parent_id` set, `type='subproject'`) dono. `resource_id` = assigned user.
  `get_userProjectList` isi table se `resource_id = <logged-in>` rows deta hai,
  `projects` se `project_name` join karke.
- **`boards.status`** exactly 5 keys: `in_discussion | to_do | in_work | in_progress | completed`.
  `getBoard` inhi 5 buckets me group karta hai.
- **Board card ka title** `editBoard` se aata hai; agar null hai to `create_board` schedule
  task ka `task_name` copy kar leta hai.
- **`notifications.user_id IS NULL`** = broadcast (sabko dikhega).
- **`risks`** frontend ke exact keys (`taskName`, `dueDate`, `state`, `impact`, `probability`,
  `projectId`) me response deta hai.

## 4. Frontend changes (WorKXKloud @ djwork_v2)

- `.env` → `VITE_API_ROOT_URL=http://localhost:8021/api`
- `src/config/api.js` → `GET_RISKS / CREATE_RISK / UPDATE_RISK / DELETE_RISK` add
- `src/hooks/useNotification.js` → mock hataya, ab `get_notifications` + mark/clear/delete
  endpoints call hote hain (optimistic update). Naya `deleteOne(id)` + `reload()` export.
- `src/pages/RiskPage.jsx` → localStorage hataya, `get_risks` se load, `create_risk` se add,
  `delete_risk` se bulk delete (selected rows par "Delete (n)" button).

> Board tab (`MyTaskProjectDetailPage`) `<ProjectBoardSection projectId readOnly />` ko
> `pm_id` nahi deta, isliye `getBoard` skip ho jaata hai — ye frontend gap hai, backend
> ready hai. `pmId` prop pass karte hi board chal jayega.
