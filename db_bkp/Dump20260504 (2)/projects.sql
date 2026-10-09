-- MySQL dump 10.13  Distrib 8.0.43, for Win64 (x86_64)
--
-- Host: localhost    Database: xmp_db
-- ------------------------------------------------------
-- Server version	8.0.43

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `projects`
--

DROP TABLE IF EXISTS `projects`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `projects` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_code` varchar(20) DEFAULT NULL,
  `project_name` varchar(255) DEFAULT NULL,
  `contact_sign_date` date DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `duration` int DEFAULT NULL,
  `project_manager` varchar(100) DEFAULT NULL,
  `project_type` varchar(50) DEFAULT NULL,
  `priority` varchar(20) DEFAULT NULL,
  `methodology` varchar(50) DEFAULT NULL,
  `project_scope` text,
  `company_logo` varchar(50) DEFAULT NULL,
  `upload_personal_document` varchar(255) DEFAULT NULL,
  `company_name` varchar(255) DEFAULT NULL,
  `location` varchar(255) DEFAULT NULL,
  `person_name` varchar(100) DEFAULT NULL,
  `role` varchar(100) DEFAULT NULL,
  `mobile` varchar(15) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `milestone` varchar(255) DEFAULT NULL,
  `milestone_date` date DEFAULT NULL,
  `percentage` decimal(5,2) DEFAULT NULL,
  `budget` int DEFAULT NULL,
  `no_billing` varchar(50) DEFAULT NULL,
  `status` varchar(50) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `contacts` json DEFAULT NULL,
  `milestones` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `project_code` (`project_code`),
  UNIQUE KEY `project_code_2` (`project_code`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `projects`
--

LOCK TABLES `projects` WRITE;
/*!40000 ALTER TABLE `projects` DISABLE KEYS */;
INSERT INTO `projects` VALUES (1,'P-2026036','ERP System Updated','2026-05-01','2026-05-05','2026-08-30',120,'Soni Mishra','Software','High','Agile','Full ERP development including HR, Finance','1777888850712.jfif','1777888850175.xlsx','ABC Pvt Ltd','Noida',NULL,NULL,NULL,NULL,NULL,NULL,NULL,500000,'No','Active','2026-05-04 07:39:19','2026-05-04 10:00:50','[{\"role\": \"Project Manager\", \"email\": \"rahul@test.com\", \"mobile\": \"9999999999\", \"person_name\": \"Rahul Sharma\"}, {\"role\": \"Developer\", \"email\": \"amit@test.com\", \"mobile\": \"8888888888\", \"person_name\": \"Amit Verma\"}]','[{\"milestone\": \"Requirement Gathering\", \"percentage\": 10, \"milestone_date\": \"2026-05-10\"}, {\"milestone\": \"Design Phase\", \"percentage\": 25, \"milestone_date\": \"2026-05-25\"}, {\"milestone\": \"Development\", \"percentage\": 50, \"milestone_date\": \"2026-07-01\"}, {\"milestone\": \"Testing\", \"percentage\": 75, \"milestone_date\": \"2026-08-01\"}, {\"milestone\": \"Deployment\", \"percentage\": 100, \"milestone_date\": \"2026-08-30\"}]'),(2,'P-2026040','ukskdfa','2026-05-04','2026-05-05','2026-07-05',43,'Ashu (Freelancer)','Website','null','Predictive','null',NULL,NULL,'asdfkj','null',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,'No Billing','Allocated','2026-05-04 07:52:13','2026-05-04 07:52:13','[{\"role\": \"ajhsdgf\", \"email\": \"a@gmail.com\", \"mobile\": \"8977987897\", \"person_name\": \"asfd\"}]','[{\"milestone\": \"BRD Sign-off\", \"percentage\": 100, \"milestone_date\": null}]');
/*!40000 ALTER TABLE `projects` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-05-05 12:10:23
